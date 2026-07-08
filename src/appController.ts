import { listen } from "@tauri-apps/api/event";
import { confirm, message, open, save } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { dirname, join } from "@tauri-apps/api/path";
import { EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, lineNumbers } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { foldEffect, foldedRanges, indentUnit, unfoldEffect } from "@codemirror/language";
import { closeBrackets, completionStatus } from "@codemirror/autocomplete";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { getEditorExtensions, themeCompartment, getThemeExtension, applyUIThemeVariables, wrapCompartment, lineNumbersCompartment, activeLineCompartment, closeBracketsCompartment, indentationGuidesCompartment, tabSizeCompartment, completionCompartment, showZwsCompartment, showZeroWidthSpaces } from "./editor/extensions";
import { createTypstAutocomplete } from "./editor/autocomplete";
import { collectDefaultTypstFunctionFolds } from "./editor/folding";
import type { EditorFoldRange } from "./editor/folding";
import { looksLikeStalePrefixDiagnostic, setEditorDiagnosticsEffect } from "./editor/diagnostics";
import type { EditorDiagnostic, EditorDiagnosticSeverity } from "./editor/diagnostics";
import { WorkspaceExplorer } from "./components/explorer";
import { TinymistLspClient } from "./compiler/lsp";
import type { EditorTextEdit, LspDiagnostic, LspLogEntry, LspSourcePosition, LspStatus } from "./compiler/lsp";
import type { AppSettings } from "./settings";
import { SettingsController } from "./settingsController";
import { fileNameFromPath, filePathFromUri, filePathKey, filePathToUri, relativeFilePath } from "./platform/paths";
import { isBinaryImagePath, isSupportedInAppPath } from "./platform/fileTypes";
import { WysiwymAdapter } from "./wysiwym/adapter";
import { PreviewFrame, type PreviewInteractionStatus } from "./preview/previewFrame";
import { PreviewSyncController, type InverseSyncResult } from "./preview/previewSyncController";
import { allowsStandalonePreview, previewRefreshStyle, previewSessionIdentity, type PreviewTarget, type PreviewRefreshStyle } from "./preview/previewPolicy";
import { LogConsoleController, type LogConsoleEntryInput } from "./diagnostics/logConsoleController";
import { EditorFontManager } from "./editor/fontManager";
import { TabStripController } from "./editor/tabStripController";
import { createAppIcon } from "./ui/icons";
import { LayoutController } from "./layout/layoutController";
import { WorkspaceStateStore } from "./workspace/workspaceStateStore";
import { RecentProjectsController } from "./workspace/recentProjectsController";
import { WorkspaceWatcher, type WorkspaceChange } from "./workspace/workspaceWatcher";
import { EditorToolbarController } from "./editor/toolbarController";
import { ContextMenuController } from "./components/contextMenuController";
import { ToolchainController, type ToolchainStatus } from "./toolchain/toolchainController";
import { DocumentOutlineController, type DocumentHeading } from "./outline/documentOutline";
import { typographyEdit, type DocumentTypography } from "./editor/documentTypography";
import { SpellcheckController, type ProviderCapabilities, type SpellingIssue } from "./editor/spellcheck";

import {
  ensureTypographyTemplateApplication,
  externalReferenceLabels,
  findLocalTemplateApplication,
  findTemplateFunctionName,
  newTypographyTemplate,
  templatePreviewSource,
  templateTypographyEdit
} from "./editor/templateTypography";

type EditorMode = "CODE" | "WYSIWYM";


type StartupTimingEntry = {
  source: string;
  label: string;
  ms: number;
};

const DEFAULT_INPUT_WIDTH_PCT = 50;
const DEFAULT_PREVIEW_WIDTH_PCT = 100 - DEFAULT_INPUT_WIDTH_PCT;
const DEFAULT_EXPLORER_WIDTH_PX = 250;

type ExamplesWorkspace = {
  workspacePath: string;
  entryPath: string;
};


type EditorTab = {
  path: string;
  content: string;
  savedContent: string;
  isDirty: boolean;
  previewRootPath: string | null;
  previewMainPath: string | null;
  previewTaskId: string | null;
  previewSessionKey: string | null;
  previewImported: boolean;
  previewStandalone: boolean;
  version: number;
  latestVersion: number;
  selectionAnchor: number;
  selectionHead: number;
  scrollTop?: number;
  scrollLeft?: number;
  foldRanges: EditorFoldRange[] | null;
  temporary?: boolean;
};

type PreviewSessionState = Pick<
  EditorTab,
  "previewRootPath" | "previewMainPath" | "previewTaskId" | "previewSessionKey" | "previewImported" | "previewStandalone"
>;

type ActivateEditorTabOptions = {
  preservePreviewSession?: PreviewSessionState;
};

type LoadFileOptions = {
  temporary?: boolean;
  preservePreviewSession?: PreviewSessionState;
};

function normalizeEditorText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export class TypstryWorkspaceController {
  private readonly startupStart = performance.now();
  private readonly startupTimings: StartupTimingEntry[] = [];
  private readonly loggedNativeStartupTimings = new Set<string>();
  private sidebarVisible = true;
  private activeMode: EditorMode = "CODE";
  private activeFilePath: string | null = null;
  private previewRootPath: string | null = null;
  private previewMainPath: string | null = null;
  private previewTaskId: string | null = null;
  private previewSessionKey: string | null = null;
  private previewImported = false;
  private previewStandalone = true;
  private pinnedLspMainPath: string | null = null;
  private pinnedMainFilePath: string | null = null;
  private workspaceRootPath: string | null = null;
  private currentVersion = 1;
  private isLoadingFile = false;
  private lspReady = false;
  private readonly lspSyncDebounceMs = 50;
  private forwardSyncDebounceMs = 120;
  private pendingLspSyncTimer: number | null = null;
  private pendingLspSyncPath: string | null = null;
  private pendingLspSyncText: string | null = null;
  private pendingLspSyncVersion: number | null = null;
  private lspSyncRequestGenerations = new Map<string, number>();
  private latestDocumentVersion = 1;
  private openTabs: EditorTab[] = [];
  private readonly openedDocumentUris = new Set<string>();
  private lastKhmerRenderPrepState: boolean | undefined = undefined;
  private lastPreviewRenderMode: PreviewRefreshStyle | undefined = undefined;
  private preparedContentsCache = new Map<string, { content: string; preparedText: string; generatedPath: string }>();
  private lspSyncGenerations = new Map<string, number>();
  private workspaceChangeQueue: Promise<void> = Promise.resolve();
  private pdfPreviewGeneration = 0;
  private pdfPreviewTimer: number | null = null;
  private pdfPreviewRunning = false;
  private queuedPdfPreviewContents: string | null = null;
  private readonly externalConflictPaths = new Set<string>();
  private readonly settingsController = new SettingsController(
    settings => this.applySettingsToRuntime(settings),
    providers => this.handleLanguageProvidersChanged(providers)
  );
  private readonly toolchainController = new ToolchainController({
    getSelectedVersion: () => this.settingsController.value.toolchain.tinymistVersion,
    setSelectedVersion: version => this.settingsController.update(settings => {
      settings.toolchain.tinymistVersion = version;
    }),
    onToolchainChanged: status => this.handleToolchainChanged(status)
  });

  private editorInstance!: EditorView;
  private readonly editorFontManager = new EditorFontManager(() => this.editorInstance);
  private readonly spellcheckController = new SpellcheckController(
    () => this.editorInstance,
    issues => this.updateSpellcheckLog(issues)
  );
  private explorer!: WorkspaceExplorer;
  private lspClient!: TinymistLspClient;

  private codePane = document.getElementById("code-editor-pane")!;
  private editorTabBar = document.getElementById("editor-tab-bar")!;
  private readonly tabStripController = new TabStripController(
    this.editorTabBar,
    document.getElementById("editor-tabs-previous") as HTMLButtonElement,
    document.getElementById("editor-tabs-next") as HTMLButtonElement
  );
  private editorVisualToolbar = document.getElementById("editor-visual-toolbar")!;
  private codeRenderPane = document.getElementById("code-render-pane")!;
  private wysiwymPane = document.getElementById("wysiwym-editor-pane")!;
  private wysiwymContainer = this.wysiwymPane.querySelector<HTMLElement>(".wysiwym-container")!;
  private readonly wysiwymAdapter = new WysiwymAdapter(this.wysiwymContainer);
  private previewPane = document.getElementById("preview-render-pane")!;
  private readonly previewFrame = new PreviewFrame(this.previewPane, point => {
    this.previewSyncController.recordTextClick(point);
  }, status => {
    this.reportPreviewInteractionStatus(status);
  }, zoomPercent => {
    this.updatePreviewZoomLabel(zoomPercent);
  });
  private readonly previewSyncController = new PreviewSyncController({
    getEditor: () => this.editorInstance,
    getClient: () => this.lspClient,
    getActiveFilePath: () => this.activeFilePath,
    getPreviewRootPath: () => this.previewRootPath,
    getPreviewTaskId: () => this.previewTaskId,
    isReady: () => this.lspReady,
    // TODO: Re-enable after the virtual PDF renderer is memory-stable.
    isEnabled: () => false,
    mapForwardPosition: async () => null
  });
  private readonly logConsoleController = new LogConsoleController(entry => this.navigateToLogEntry(entry));
  private readonly layoutController = new LayoutController(
    () => this.saveWorkspaceState(),
    () => this.logConsoleController.setVisible(false),
    () => this.previewFrame.currentUrl,
    message => this.appendDeveloperLog({ kind: "info", source: "preview layout", message })
  );
  private readonly workspaceStateStore = new WorkspaceStateStore();
  private readonly recentProjectsController = new RecentProjectsController(path => this.openWorkspace(path));
  private readonly workspaceWatcher = new WorkspaceWatcher(
    change => {
      this.workspaceChangeQueue = this.workspaceChangeQueue
        .then(() => this.handleWorkspaceChange(change))
        .catch(error => this.reportWorkspaceWatchError(error));
    },
    error => this.reportWorkspaceWatchError(error)
  );
  private readonly editorToolbarController = new EditorToolbarController({
    getMode: () => this.activeMode,
    getEditor: () => this.editorInstance,
    wysiwymContainer: this.wysiwymContainer,
    serializeWysiwym: () => this.mapWysiwymToMarkup(),
    renderWysiwym: markup => this.mapMarkupToWysiwym(markup),
    save: () => this.saveActiveFile(),
    syncPreview: cursor => this.previewSyncController.renderAtCursor(cursor),
    applyTypography: (config, target) => this.applyTypography(config, target)
    // TODO: Re-enable when the WYSIWYM layout is ready for use.
    // toggleMode: () => this.switchViewLayoutMode()
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
    closeTab: path => this.closeEditorTab(path, true),
    closeTabInteractive: path => this.closeEditorTab(path, false),
    closeOtherTabs: path => this.closeOtherTabs(path),
    restartWorkspace: () => this.restartWorkspace(),
    getSpellingIssue: (x, y, target) => {
      if (target) {
        const spellingSpan = target.closest(".cm-spelling-unknown, .cm-spelling-ignored");
        if (spellingSpan) {
          try {
            let pos = spellingSpan.firstChild ? this.editorInstance.posAtDOM(spellingSpan.firstChild) : null;
            if (pos === null) {
              pos = this.editorInstance.posAtDOM(spellingSpan);
            }
            if (pos !== null) {
              const issue = this.spellcheckController.issueAt(pos);
              if (issue) return issue;
            }
          } catch (e) {
            console.error("posAtDOM failed in getSpellingIssue:", e);
          }
        }
      }
      
      try {
        let position = this.editorInstance.posAtCoords({ x, y });
        if (position === null) {
          position = this.editorInstance.state.selection.main.head;
        }
        const issue = this.spellcheckController.issueAt(position);
        if (issue) return issue;
      } catch (e) {
        console.error("posAtCoords or line lookup failed in getSpellingIssue:", e);
      }
      return null;
    },
    getSpellingSuggestions: issue => this.spellcheckController.suggestions(issue),
    replaceSpelling: (issue, replacement) => this.spellcheckController.replace(issue, replacement),
    addSpellingToDictionary: issue => this.settingsController.update(settings => {
      if (!settings.editor.userDictionary.includes(issue.word)) {
        settings.editor.userDictionary.push(issue.word);
      }
    }),
    setSpellingIgnored: (issue, ignored) => this.settingsController.update(settings => {
      settings.editor.ignoredWords = ignored
        ? [...new Set([...settings.editor.ignoredWords, issue.word])]
        : settings.editor.ignoredWords.filter(word => word !== issue.word);
    }),
    isPinnedMainFile: path => this.isPinnedMainFile(path),
    setPinnedMainFile: path => this.setPinnedMainFile(path)
  });
  private readonly documentOutlineController = new DocumentOutlineController(
    document.getElementById("document-outline-tree")!,
    document.getElementById("document-outline-section")!,
    heading => void this.navigateToOutlineHeading(heading)
  );
  private lspStatus = document.getElementById("lsp-status")!;
  private lspStatusDot = this.lspStatus.querySelector(".status-dot") as HTMLElement;
  private lspStatusText = this.lspStatus.querySelector(".status-text") as HTMLElement;

  public async bootstrap() {
    await this.timeStartup("load settings", () => this.settingsController.load());
    for (const entry of this.settingsController.getTimings()) this.recordStartupTimingEntry(entry);
    await this.timeStartup("initialize spellcheck providers", () => this.spellcheckController.initialize());
    this.settingsController.setLanguageProviders(this.spellcheckController.getAllProviders());
    this.timeStartupSync("initialize recent projects", () => this.recentProjectsController.initialize());
    this.timeStartupSync("initialize CodeMirror", () => this.initCodeMirror());
    this.timeStartupSync("initialize document outline", () => this.documentOutlineController.initialize());
    this.timeStartupSync("apply settings to runtime", () => this.applySettingsToRuntime(this.settingsController.value));
    this.timeStartupSync("initialize explorer", () => this.initExplorer());
    this.timeStartupSync("initialize editor toolbar", () => this.editorToolbarController.initialize());
    this.timeStartupSync("initialize tab strip", () => this.tabStripController.initialize());
    this.timeStartupSync("bind global events", () => this.bindGlobalEvents());
    this.timeStartupSync("initialize layout", () => this.layoutController.initialize());
    this.timeStartupSync("initialize word wrap label", () => this.initWordWrap());
    this.timeStartupSync("initialize invisibles toggle", () => this.initZwsToggle());
    this.timeStartupSync("initialize settings panel", () => this.settingsController.initializePanel());
    this.timeStartupSync("initialize toolchain UI", () => this.toolchainController.initialize());
    this.timeStartupSync("initialize context menu", () => this.contextMenuController.initialize());
    this.timeStartupSync("initialize log console", () => this.logConsoleController.initialize());
    this.timeStartupSync("update workspace visibility", () => this.updateWorkspaceViewportVisibility());

    await this.timeStartup("show main window", () => getCurrentWindow().show());
    this.recordStartupTiming("frontend startup", "frontend bootstrap until window shown", this.startupStart);
    void this.logNativeStartupTimingsToConsole();
    void this.finishStartupInitialization();

    this.setLspStatus({ kind: "starting", message: "Preparing toolchain" });

    let toolchain: ToolchainStatus | null = null;
    try {
      toolchain = await this.timeStartup("get toolchain status", () => invoke<ToolchainStatus>("get_toolchain_status"));
    } catch (e) {
      console.error("Failed to check toolchain status:", e);
    }

    if (!toolchain?.tinymistVersion) {
      toolchain = await this.showToolchainSetupDialog();
    }

    this.toolchainController.setStatus(toolchain ?? { typstVersion: null, typstSource: null, tinymistVersion: null, tinymistSource: null, lspAvailable: false, message: "" });
    await this.timeStartup("initialize Tinymist LSP", () => this.initLsp(Boolean(toolchain?.lspAvailable)));
    this.recordStartupTiming("frontend startup", "frontend bootstrap including LSP", this.startupStart);
  }

  private updateWorkspaceViewportVisibility() {
    const welcomeScreen = document.getElementById("welcome-screen");
    const inputWrapper = document.getElementById("input-container-wrapper");
    const previewWrapper = document.getElementById("preview-container-wrapper");
    const resizer = document.getElementById("editor-preview-resizer");
    const explorerSidebar = document.getElementById("explorer-sidebar");
    const explorerResizer = document.getElementById("explorer-resizer");
    const sidebarActivityBar = document.getElementById("sidebar-activity-bar");
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
      this.layoutController.dockPreview();
    } else {
      inputWrapper?.classList.add("hidden");
      previewWrapper?.classList.add("hidden");
      resizer?.classList.add("hidden");
    }

    if (this.workspaceRootPath) {
      sidebarActivityBar?.classList.remove("hidden");
      this.applySidebarVisibility();
      appMenus?.classList.remove("hidden");
    } else {
      explorerSidebar?.classList.add("hidden");
      explorerResizer?.classList.add("hidden");
      sidebarActivityBar?.classList.add("hidden");
      appMenus?.classList.add("hidden");
    }
  }

  private toggleSidebar(): void {
    if (!this.workspaceRootPath) return;
    this.sidebarVisible = !this.sidebarVisible;
    this.applySidebarVisibility();
    this.saveWorkspaceState();
  }

  private restoreDefaultLayout(): void {
    if (!this.workspaceRootPath) return;
    this.sidebarVisible = true;

    const explorerSidebar = document.getElementById("explorer-sidebar");
    if (explorerSidebar) explorerSidebar.style.width = `${DEFAULT_EXPLORER_WIDTH_PX}px`;
    this.applySidebarVisibility();

    const inputWrapper = document.getElementById("input-container-wrapper");
    const previewWrapper = document.getElementById("preview-container-wrapper");
    const previewResizer = document.getElementById("editor-preview-resizer");
    const dockButton = document.getElementById("dock-preview-status-btn");

    if (inputWrapper) {
      inputWrapper.style.width = `${DEFAULT_INPUT_WIDTH_PCT}%`;
      if (this.activeFilePath) inputWrapper.classList.remove("hidden");
    }
    if (previewWrapper) {
      previewWrapper.style.width = `${DEFAULT_PREVIEW_WIDTH_PCT}%`;
      if (this.activeFilePath) {
        previewWrapper.classList.remove("hidden");
        previewWrapper.style.display = "flex";
      } else {
        previewWrapper.style.display = "";
      }
    }
    if (previewResizer) {
      previewResizer.style.display = this.activeFilePath ? "block" : "";
      previewResizer.classList.toggle("hidden", !this.activeFilePath);
    }
    dockButton?.classList.add("hidden");

    const logConsole = document.getElementById("log-console");
    if (logConsole) logConsole.style.height = "";
    this.logConsoleController.setVisible(false);

    this.updateWorkspaceViewportVisibility();
    this.saveWorkspaceState();
  }

  private applySidebarVisibility(): void {
    const explorerSidebar = document.getElementById("explorer-sidebar");
    const explorerResizer = document.getElementById("explorer-resizer");
    const sidebarToggle = document.getElementById("sidebar-toggle-button") as HTMLButtonElement | null;
    explorerSidebar?.classList.toggle("hidden", !this.sidebarVisible);
    if (explorerSidebar) explorerSidebar.style.display = "";
    explorerResizer?.classList.toggle("hidden", !this.sidebarVisible);
    sidebarToggle?.setAttribute("aria-expanded", String(this.sidebarVisible));
    sidebarToggle?.setAttribute("aria-label", this.sidebarVisible ? "Hide sidebar" : "Show sidebar");
    if (sidebarToggle) sidebarToggle.title = this.sidebarVisible ? "Hide sidebar" : "Show sidebar";
  }

  private applySettingsToRuntime(settings: AppSettings) {
    const { appearance, editor, preview } = settings;
    document.documentElement.style.setProperty("--editor-font-size", `${appearance.editorFontSize}px`);
    document.documentElement.style.setProperty("--editor-line-height", String(appearance.editorLineHeight));
    this.forwardSyncDebounceMs = preview.syncDebounceMs;
    this.editorFontManager.configure(editor.codeFont, editor.unicodeFont);
    this.spellcheckController.setEnabledProviders(editor.languageProviders);
    this.spellcheckController.setEnabled(editor.spellcheck);
    this.spellcheckController.setUserDictionary(editor.userDictionary);
    this.spellcheckController.setIgnoredWords(editor.ignoredWords);

    void applyUIThemeVariables(appearance.theme);

    const khmerPrepChanged = this.lastKhmerRenderPrepState !== undefined && this.lastKhmerRenderPrepState !== preview.khmerRenderPreparation;
    this.lastKhmerRenderPrepState = preview.khmerRenderPreparation;
    const previewRenderModeChanged = this.lastPreviewRenderMode !== undefined && this.lastPreviewRenderMode !== preview.renderMode;
    this.lastPreviewRenderMode = preview.renderMode;

    const khmerPrepStatus = document.getElementById("khmer-prep-status");
    if (khmerPrepStatus) {
      if (preview.khmerRenderPreparation) {
        khmerPrepStatus.classList.remove("hidden");
      } else {
        khmerPrepStatus.classList.add("hidden");
      }
    }

    if (khmerPrepChanged) {
      void this.prepareRenderProjectIfNeeded().then(() => this.refreshActivePreviewRoot());
    } else if (previewRenderModeChanged) {
      void this.refreshActivePreviewRoot();
    }

    if (this.editorInstance) {
      const editorView = this.editorInstance;
      const indentation = " ".repeat(editor.tabSize);
      editorView.dispatch({
        effects: [
          themeCompartment.reconfigure(getThemeExtension(appearance.theme)),
          wrapCompartment.reconfigure(editor.wordWrap ? EditorView.lineWrapping : []),
          lineNumbersCompartment.reconfigure(editor.lineNumbers ? lineNumbers() : []),
          activeLineCompartment.reconfigure(editor.highlightActiveLine ? [highlightActiveLineGutter(), highlightActiveLine()] : []),
          closeBracketsCompartment.reconfigure(editor.autoCloseBrackets ? closeBrackets() : []),
          indentationGuidesCompartment.reconfigure(editor.indentationGuides ? indentationMarkers() : []),
          tabSizeCompartment.reconfigure([EditorState.tabSize.of(editor.tabSize), indentUnit.of(indentation)]),
          showZwsCompartment.reconfigure(editor.showZws ? showZeroWidthSpaces : []),
          completionCompartment.reconfigure(createTypstAutocomplete(
              () => this.lspClient,
              () => this.getActiveLspUri(),
              () => this.flushPendingLspSync(),
              editor.wordCompletion,
              () => this.spellcheckController.getProviders()
          ))
        ]
      });
      window.requestAnimationFrame(() => {
        if (this.editorInstance === editorView) editorView.requestMeasure();
      });
    }

    const wrapLabel = document.getElementById("word-wrap-label");
    if (wrapLabel) wrapLabel.textContent = editor.wordWrap ? "Wrap: On" : "Wrap: Off";
    const zwsLabel = document.getElementById("zws-label");
    if (zwsLabel) zwsLabel.textContent = editor.showZws ? "Invisibles: On" : "Invisibles: Off";
    if (!preview.cursorSync) this.previewSyncController.clearForward();
  }

  private handleLanguageProvidersChanged(providers: Parameters<SpellcheckController["setProviders"]>[0]): void {
    this.spellcheckController.setProviders(providers);
    const editor = this.settingsController.value.editor;
    this.spellcheckController.setEnabledProviders(editor.languageProviders);
    if (!this.editorInstance) return;
    this.editorInstance.dispatch({
      effects: completionCompartment.reconfigure(createTypstAutocomplete(
        () => this.lspClient,
        () => this.getActiveLspUri(),
        () => this.flushPendingLspSync(),
        editor.wordCompletion,
        () => this.spellcheckController.getProviders()
      ))
    });
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

  private initZwsToggle() {
    const zwsToggleBtn = document.getElementById("zws-toggle");
    const zwsLabel = document.getElementById("zws-label");
    if (zwsToggleBtn && zwsLabel) {
      zwsLabel.textContent = this.settingsController.value.editor.showZws ? "Invisibles: On" : "Invisibles: Off";
      zwsToggleBtn.addEventListener("click", () => {
        this.settingsController.update(settings => {
          settings.editor.showZws = !settings.editor.showZws;
        });
      });
    }
  }


  private async showToolchainSetupDialog(): Promise<ToolchainStatus | null> {
    return new Promise<ToolchainStatus | null>((resolve) => {
      const overlay = document.getElementById("toolchain-setup-overlay");
      const versionSelect = document.getElementById("toolchain-version-select") as HTMLSelectElement | null;
      const versionHint = document.getElementById("toolchain-version-hint");
      const downloadBtn = document.getElementById("toolchain-download-btn") as HTMLButtonElement | null;
      const exitBtn = document.getElementById("toolchain-exit-btn") as HTMLButtonElement | null;
      const progressContainer = document.getElementById("toolchain-progress-container");
      const progressLabel = document.getElementById("toolchain-progress-label");
      const progressBar = document.getElementById("toolchain-progress-bar") as HTMLElement | null;
      const actions = document.getElementById("toolchain-setup-actions");
      const versionPicker = document.getElementById("toolchain-version-picker");

      if (!overlay || !versionSelect || !downloadBtn || !exitBtn || !progressContainer || !progressBar || !actions || !progressLabel || !versionHint || !versionPicker) {
        resolve(null);
        return;
      }

      overlay.classList.remove("hidden");

      // Fetch available releases and populate the select
      void (async () => {
        try {
          type TinymistRelease = { version: string; publishedAt: string | null };
          const releases = await invoke<TinymistRelease[]>("list_tinymist_releases");
          versionSelect.innerHTML = "";
          const placeholder = document.createElement("option");
          placeholder.value = "";
          placeholder.textContent = "Select a version...";
          versionSelect.appendChild(placeholder);
          for (const release of releases) {
            const opt = document.createElement("option");
            opt.value = release.version;
            opt.textContent = release.version;
            versionSelect.appendChild(opt);
          }
          versionHint.textContent = `${releases.length} stable releases available. The latest is ${releases[0]?.version ?? "unknown"}.`;
        } catch {
          versionSelect.innerHTML = "<option value=\"\">Failed to load releases</option>";
          versionHint.textContent = "Could not reach GitHub. Check your internet connection and try again.";
        }
      })();

      versionSelect.addEventListener("change", () => {
        const hasVersion = Boolean(versionSelect.value);
        downloadBtn.disabled = !hasVersion;
        downloadBtn.style.opacity = hasVersion ? "1" : "0.55";
        downloadBtn.style.cursor = hasVersion ? "pointer" : "default";
      });

      exitBtn.addEventListener("click", () => {
        void getCurrentWindow().close();
      });

      downloadBtn.addEventListener("click", () => {
        const selectedVersion = versionSelect.value;
        if (!selectedVersion) return;

        void (async () => {
          versionPicker.classList.add("hidden");
          actions.classList.add("hidden");
          progressContainer.classList.remove("hidden");

          let progress = 0;
          progressBar.style.width = "0%";
          progressLabel.textContent = `Installing Tinymist ${selectedVersion}...`;

          const progressInterval = window.setInterval(() => {
            if (progress < 15) {
              progress += 2;
              progressLabel.textContent = `Installing Tinymist ${selectedVersion}...`;
            } else if (progress < 55) {
              progress += 1.5;
              progressLabel.textContent = "Downloading Tinymist...";
            } else if (progress < 75) {
              progress += 1;
              progressLabel.textContent = "Verifying embedded Typst compiler...";
            } else if (progress < 93) {
              progress += 0.5;
              progressLabel.textContent = "Finalizing toolchain...";
            }
            progressBar.style.width = String(Math.min(93, progress)) + "%";
          }, 300);

          try {
            const status = await invoke<ToolchainStatus>("install_tinymist_toolchain", { version: selectedVersion });
            window.clearInterval(progressInterval);
            progressBar.style.width = "100%";
            progressLabel.textContent = "Installation complete!";
            await new Promise(r => window.setTimeout(r, 700));
            overlay.classList.add("hidden");
            resolve(status);
          } catch (error) {
            window.clearInterval(progressInterval);
            progressBar.style.width = "0%";
            progressLabel.textContent = "Installation failed. Please try again.";
            await message(String(error), { title: "Toolchain installation failed", kind: "error" });
            progressContainer.classList.add("hidden");
            versionPicker.classList.remove("hidden");
            actions.classList.remove("hidden");
          }
        })();
      });
    });
  }


  private initCodeMirror() {
    const initialDocument = "";
    this.editorFontManager.initialize();
    this.editorInstance = new EditorView({
      state: EditorState.create({
        doc: initialDocument,
        extensions: [
          getEditorExtensions(
            () => this.lspClient,
            () => this.getActiveLspUri(),
            () => this.flushPendingLspSync(),
            (uri, line, character) => void this.navigateToLspLocation(uri, line, character),
            () => this.spellcheckController.getProviders()
          ),
          this.spellcheckController.extension(),
          EditorView.updateListener.of((update) => {
            this.spellcheckController.completionStateChanged(completionStatus(update.state) !== null);
            if (update.docChanged) {
              const currentText = update.state.doc.toString();
              this.previewSyncController.clearForward();
              this.editorFontManager.updateDocument(currentText);
              this.handleContentMutation(currentText);
              this.spellcheckController.documentChanged(update);
            }
            if (update.selectionSet) {
              this.spellcheckController.selectionChanged(update.docChanged);
              this.documentOutlineController.setCursorPosition(update.state.selection.main.head, this.activeFilePath);
            }
            if (!update.docChanged && this.shouldForwardSyncSelectionUpdate(update)) {
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
    this.explorer = new WorkspaceExplorer(
      document.getElementById("workspace-explorer-tree")!,
      (path: string, options?: { temporary?: boolean }) => {
        void this.loadFile(path, options);
      },
      (path: string) => this.isPinnedMainFile(path)
    );
  }

  private renderEditorTabs() {
    this.editorTabBar.innerHTML = "";

    for (const tab of this.openTabs) {
      const tabButton = document.createElement("button");
      tabButton.className = `editor-tab${tab.path === this.activeFilePath ? " active" : ""}${tab.isDirty ? " dirty" : ""}${tab.temporary ? " temporary" : ""}`;
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
      closeButton.appendChild(createAppIcon("x", { size: 13 }));
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

      tabButton.addEventListener("dblclick", () => {
        void this.promoteToPermanent(tab);
      });

      this.editorTabBar.appendChild(tabButton);
    }
  }

  private async promoteToPermanent(tab: EditorTab) {
    if (!tab.temporary) return;
    tab.temporary = false;
    this.renderEditorTabs();
    this.saveWorkspaceState();
  }

  private getActiveTab(): EditorTab | null {
    if (!this.activeFilePath) return null;
    return this.openTabs.find((tab) => tab.path === this.activeFilePath) ?? null;
  }

  private persistActiveTabState() {
    const tab = this.getActiveTab();
    if (!tab || !this.editorInstance) return;
    if (isBinaryImagePath(tab.path)) return;

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
    
    if (tab.isDirty && tab.temporary) {
      void this.promoteToPermanent(tab);
    } else if (wasDirty !== tab.isDirty) {
      this.renderEditorTabs();
    }
  }

  private updateEditorTabPath(oldPath: string, newPath: string) {
    const tab = this.openTabs.find((candidate) => candidate.path === oldPath);
    if (!tab) return;

    tab.path = newPath;
    if (this.activeFilePath === oldPath) {
      this.activeFilePath = newPath;
      this.spellcheckController.activateDocument(filePathKey(newPath));
      this.previewRootPath = tab.previewRootPath;
      this.previewMainPath = tab.previewMainPath;
      this.previewTaskId = tab.previewTaskId;
      this.previewSessionKey = tab.previewSessionKey;
      this.previewImported = tab.previewImported;
      this.previewStandalone = tab.previewStandalone;
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
      this.previewMainPath = null;
      this.previewTaskId = null;
      this.previewSessionKey = null;
      this.previewImported = false;
      this.previewStandalone = true;
      this.clearDiagnostics();
      this.clearPendingLspSync();
      this.previewSyncController.clearForward();

      if (nextTab) {
        await this.activateEditorTab(nextTab.path, false);
      } else {
        this.spellcheckController.activateDocument("");
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
        this.previewFrame.clear();
        this.editorFontManager.updateDocument("");
        this.documentOutlineController.clear();
        if (this.activeMode === "WYSIWYM") {
          this.mapMarkupToWysiwym("");
        }
      }
    }

    this.renderEditorTabs();
    this.updateWorkspaceViewportVisibility();
    this.saveWorkspaceState();
  }

  private async activateEditorTab(path: string, persistCurrent = true, options: ActivateEditorTabOptions = {}) {
    if (this.activeFilePath === path) {
      if (persistCurrent) {
        this.persistActiveTabState();
        this.renderEditorTabs();
      }
      if (options.preservePreviewSession) {
        const tab = this.getActiveTab();
        if (tab) this.applyPreviewSessionToTab(tab, options.preservePreviewSession);
        if (options.preservePreviewSession.previewSessionKey) {
          this.previewFrame.activateSession(options.preservePreviewSession.previewSessionKey);
        }
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

    this.spellcheckController.activateDocument(filePathKey(path));

    this.currentVersion = tab.version;
    this.latestDocumentVersion = tab.latestVersion;
    this.previewSyncController.reset();
    this.clearDiagnostics();

    this.isLoadingFile = true;
    try {
      const codeRenderPane = document.getElementById("code-render-pane");
      const imageViewerPane = document.getElementById("image-viewer-pane");
      const imageViewerImg = document.getElementById("image-viewer-img") as HTMLImageElement;
      const imageViewerInfo = document.getElementById("image-viewer-info");

      if (isBinaryImagePath(path)) {
        codeRenderPane?.classList.add("hidden");
        imageViewerPane?.classList.remove("hidden");
        if (imageViewerImg) imageViewerImg.style.display = "none"; // Hide image element in editor
        if (imageViewerInfo) {
          imageViewerInfo.innerHTML = `
            <div class="preview-disabled-placeholder" style="padding:0;background:transparent;">
              <div class="preview-disabled-icon" style="font-size:32px;margin-bottom:12px;">💾</div>
              <div class="preview-disabled-title" style="font-size:16px;">Binary File</div>
              <div class="preview-disabled-msg" style="font-size:13px;max-width:300px;">Cannot load raw binary in the text editor.</div>
            </div>
          `;
        }
        
        document.getElementById("wysiwym-editor-pane")?.classList.add("hidden");

        this.renderInteractiveImageViewer(tab.content);
        this.editorToolbarController.setDisabled(true);
        this.activeFilePath = path;
        this.isLoadingFile = false;
        this.updateWorkspaceViewportVisibility();
        this.saveWorkspaceState();
        return;
      } else {
        document.querySelector(".preview-actions")?.classList.remove("hidden");
        codeRenderPane?.classList.remove("hidden");
        imageViewerPane?.classList.add("hidden");
        if (imageViewerImg) imageViewerImg.style.display = "block"; // Reset styling
        if (this.activeMode === "WYSIWYM") {
          document.getElementById("wysiwym-editor-pane")?.classList.remove("hidden");
        }
        
        const ext = path.split('.').pop()?.toLowerCase();
        if (ext === "typ") {
          this.editorToolbarController.setDisabled(false);
        } else {
          this.editorToolbarController.setDisabled(true);
          if (ext === "svg") {
            this.previewFrame.setMessage(
              `<div style="display:flex;align-items:center;justify-content:center;height:100%;width:100%;background:var(--ui-bg);box-sizing:border-box;padding:20px;overflow:auto;">` +
              tab.content +
              `</div>`
            );
          } else {
            this.previewFrame.setMessage(
              `<div class="preview-disabled-placeholder">` +
              `<div class="preview-disabled-icon">🚫</div>` +
              `<div class="preview-disabled-title">Preview Unavailable</div>` +
              `<div class="preview-disabled-msg">Live preview is not supported for ${ext?.toUpperCase() || "this"} files.</div>` +
              `</div>`
            );
          }
        }
      }

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
    await this.prepareRenderProjectIfNeeded();
    let previewTarget: PreviewTarget | null = null;
    if (options.preservePreviewSession) {
      this.applyPreviewSessionToTab(tab, options.preservePreviewSession);
      if (options.preservePreviewSession.previewSessionKey) {
        this.previewFrame.activateSession(options.preservePreviewSession.previewSessionKey);
      }
    } else if (!this.pinnedMainFilePath) {
      this.previewFrame.setMessage(this.noMainFileMessage());
    } else {
      previewTarget = await invoke<PreviewTarget>("resolve_preview_main", {
        filePath: path,
        workspaceRootPath: this.workspaceRootPath,
        fileContents: tab.content,
        pinnedMainPath: this.pinnedMainFilePath
      });
      if (previewTarget.disabled) {
        this.applyPreviewTargetToTab(tab, previewTarget);
      } else {
        previewTarget = await this.prepareTemplateAwarePreview(previewTarget, path, tab.content);
        const existingMainSession = this.captureCurrentMainSessionForImportedTarget(previewTarget);
        if (existingMainSession) {
          this.applyPreviewSessionToTab(tab, existingMainSession);
          if (existingMainSession.previewSessionKey) {
            this.previewFrame.activateSession(existingMainSession.previewSessionKey);
          }
        } else {
          this.applyPreviewTargetToTab(tab, previewTarget);
        }
      }
    }
    this.clearPendingLspSync();
    this.previewSyncController.clearForward();
    this.renderEditorTabs();
    this.editorFontManager.updateDocument(tab.content);
    this.spellcheckController.schedule();
    if (path.toLowerCase().endsWith(".typ")) {
      void this.documentOutlineController.update(
        path, 
        tab.content, 
        this.workspaceRootPath || "", 
        async (p) => {
          try {
            return await invoke<string>("read_workspace_file", { path: p });
          } catch {
            return null;
          }
        }
      );
      this.documentOutlineController.setCursorPosition(this.editorInstance.state.selection.main.head, this.activeFilePath);
    } else {
      this.documentOutlineController.clear();
    }


    if (this.lspReady && this.lspClient) {
      const lspRes = await this.getLspUriAndContent(path, tab.content);
      if (lspRes) {
        const { uri: lspUri, content: lspContent } = lspRes;
        await this.openDocumentIfNeeded(lspUri, lspContent, this.currentVersion);
      }
      const pinChanged = await this.updatePinnedMain(previewTarget?.mainPath ?? this.previewMainPath);
      if (pinChanged) {
        await this.recheckActiveDocumentAfterPin(tab.content);
      }

      if (options.preservePreviewSession) {
        // preserve
      } else if (!this.pinnedMainFilePath) {
        this.previewFrame.setMessage(this.noMainFileMessage());
      } else if (previewTarget?.disabled) {
        this.previewFrame.setMessage(this.disabledPreviewMessage());
      } else if (this.previewRootPath) {
        void this.renderPdfPreview(tab.content);
      } else {
        this.previewFrame.setMessage(`<div style="padding: 20px; color: #5f6368; font-family: var(--font-family-sans);">No preview root found for this library/template file. Diagnostics are still active.</div>`);
      }
    } else {
      if (!options.preservePreviewSession && this.previewRootPath) {
        void this.renderPdfPreview(tab.content);
      }
    }

    if (this.activeMode === "WYSIWYM") {
      this.mapMarkupToWysiwym(tab.content);
    }

    this.updateWorkspaceViewportVisibility();
    this.editorInstance.focus();
    this.saveWorkspaceState();
  }

  private async initLsp(shouldConnect = true) {
    if (!this.lspClient) {
      this.lspClient = new TinymistLspClient(
        () => {
          if (!this.workspaceRootPath) return null;
          if (this.settingsController.value.preview.khmerRenderPreparation) {
            const cacheRoot = this.getCacheRootPath();
            return cacheRoot ? `${cacheRoot}/render` : this.workspaceRootPath;
          }
          return this.workspaceRootPath;
        },
        () => {},
        (status) => this.setLspStatus(status),
        (uri, position) => this.handleInverseSync(uri, position),
        (uri, diagnostics, version) => this.handleLspDiagnostics(uri, diagnostics, version),
        (entry) => this.appendLspLog(entry),
        (items) => this.documentOutlineController.updatePreviewPositions(items)
      );
      this.lspClient.setEditorView(this.editorInstance);
    }
    if (!shouldConnect) {
      this.lspReady = false;
      this.setLspStatus({ kind: "stopped", message: "Compiler preview (LSP unavailable)" });
      return;
    }
    try {
      await this.lspClient.connect();
      this.lspReady = true;
    } catch (e) {
      this.lspReady = false;
      console.warn("Tinymist LSP instance offline.", e);
    }
  }

  private async handleToolchainChanged(status: ToolchainStatus) {
    this.toolchainController.setStatus(status);
    this.lspReady = false;
    this.pinnedLspMainPath = null;
    this.openedDocumentUris.clear();
    this.previewFrame.clear();
    await this.initLsp(status.lspAvailable);
    const activePath = this.activeFilePath;
    if (activePath) {
      this.activeFilePath = null;
      await this.activateEditorTab(activePath, false);
    }
  }



  private async loadFile(path: string, options: LoadFileOptions = {}) {
    if (!isSupportedInAppPath(path)) {
      const shouldOpenExternally = await confirm(
        `${fileNameFromPath(path)} cannot be opened in Typstry. Would you like to open it with your system application?`,
        {
          title: "Unsupported File Format",
          kind: "warning",
          okLabel: "Open Externally",
          cancelLabel: "Cancel"
        }
      );
      if (shouldOpenExternally) {
        try {
          await invoke("open_file_externally", { path });
        } catch (error) {
          console.error("Failed to open file externally:", error);
          await message(`The file could not be opened externally.\n\n${String(error)}`, {
            title: "Open External File Failed",
            kind: "error"
          });
        }
      }
      return;
    }

    const existingTab = this.openTabs.find((tab) => filePathKey(tab.path) === filePathKey(path));
    if (existingTab) {
      if (!options.temporary) {
        void this.promoteToPermanent(existingTab);
      }
      await this.activateEditorTab(existingTab.path, true, {
        preservePreviewSession: options.preservePreviewSession
      });
      return;
    }

    try {
      const contents = isBinaryImagePath(path)
        ? await invoke<string>("read_workspace_file_as_base64", { path })
        : normalizeEditorText(await invoke<string>("read_workspace_file", { path }));
      const newTab: EditorTab = {
        path,
        content: contents,
        savedContent: contents,
        isDirty: false,
        previewRootPath: null,
        previewMainPath: null,
        previewTaskId: null,
        previewSessionKey: null,
        previewImported: false,
        previewStandalone: true,
        version: 1,
        latestVersion: 1,
        selectionAnchor: 0,
        selectionHead: 0,
        foldRanges: null,
        temporary: options.temporary
      };

      if (options.temporary) {
        const existingTempIndex = this.openTabs.findIndex(t => t.temporary && !t.isDirty);
        if (existingTempIndex >= 0) {
          this.openTabs.splice(existingTempIndex, 1);
        }
      }

      this.openTabs.push(newTab);
      this.renderEditorTabs();
      await this.activateEditorTab(path, true, {
        preservePreviewSession: options.preservePreviewSession
      });
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
      if (this.activeMode === "CODE" && this.settingsController.value.editor.formatOnSave) {
        await this.formatActiveDocument({ silent: true });
      }

      const content = this.activeMode === "WYSIWYM"
        ? this.mapWysiwymToMarkup()
        : this.editorInstance.state.doc.toString();

      await invoke("save_workspace_file", {
        path: this.activeFilePath,
        contents: content
      });

      if (this.lspReady && this.lspClient) {
        await this.flushPendingLspSync();
        const lspRes = await this.getLspUriAndContent(this.activeFilePath, content);
        if (lspRes) {
          const { uri: lspUri, content: lspContent } = lspRes;
          await this.lspClient.notifyTextSave(lspUri, lspContent);
        }
      }

      const activeTab = this.getActiveTab();
      if (activeTab) {
        activeTab.content = content;
        activeTab.savedContent = content;
        activeTab.isDirty = false;
        this.externalConflictPaths.delete(filePathKey(activeTab.path));
        this.renderEditorTabs();
      }
      this.setLspStatus({ kind: "preview-ready", message: "File saved" });
      if (this.settingsController.value.preview.renderMode === "on-save") {
        void this.renderPdfPreview(content);
      }

    } catch (error) {
      const message = `Save failed: ${String(error)}`;
      console.error(message);
      this.setLspStatus({ kind: "error", message });
      alert(message);
    }
  }

  private async formatActiveDocument(options: { silent?: boolean } = {}): Promise<boolean> {
    if (!this.activeFilePath || this.activeMode !== "CODE") return false;
    if (!this.lspReady || !this.lspClient) {
      if (!options.silent) this.setLspStatus({ kind: "error", message: "Formatter unavailable until Tinymist LSP is ready" });
      return false;
    }

    try {
      await this.flushPendingLspSync();
      const doc = this.editorInstance.state.doc;
      const edits = await this.lspClient.formatTextDocument(filePathToUri(this.activeFilePath), doc, {
        tabSize: this.settingsController.value.editor.tabSize,
        insertSpaces: true
      });
      this.applyFormattingEdits(edits);
      if (!options.silent) {
        this.setLspStatus({ kind: "preview-ready", message: edits.length > 0 ? "Document formatted" : "Document already formatted" });
      }
      return true;
    } catch (error) {
      this.appendLspLog({
        kind: "warning",
        source: "formatter",
        message: `Format failed: ${String(error)}`
      });
      if (!options.silent) this.setLspStatus({ kind: "error", message: `Format failed: ${String(error)}` });
      return false;
    }
  }

  private applyFormattingEdits(edits: EditorTextEdit[]): void {
    if (edits.length === 0) return;
    const changes = edits
      .slice()
      .sort((a, b) => a.from - b.from)
      .map(edit => ({ from: edit.from, to: edit.to, insert: edit.insert }));
    this.editorInstance.dispatch({
      changes,
      userEvent: "input.format"
    });
  }

  private workspaceText(path: string): Promise<string> {
    const tab = this.openTabs.find(candidate => filePathKey(candidate.path) === filePathKey(path));
    return tab ? Promise.resolve(tab.content) : invoke<string>("read_workspace_file", { path });
  }

  private async writeWorkspaceText(path: string, content: string): Promise<void> {
    await invoke("save_workspace_file", { path, contents: content });
    const tab = this.openTabs.find(candidate => filePathKey(candidate.path) === filePathKey(path));
    if (tab) {
      tab.content = content;
      tab.savedContent = content;
      tab.isDirty = false;
      tab.version++;
      tab.latestVersion = tab.version;
      if (this.activeFilePath && filePathKey(this.activeFilePath) === filePathKey(path)) {
        this.isLoadingFile = true;
        try {
          this.editorInstance.dispatch({
            changes: { from: 0, to: this.editorInstance.state.doc.length, insert: content }
          });
        } finally {
          this.isLoadingFile = false;
        }
      }
      this.renderEditorTabs();
    }
    if (this.lspReady && this.lspClient) {
      const lspRes = await this.getLspUriAndContent(path, content);
      if (lspRes) {
        const { uri: lspUri, content: lspContent } = lspRes;
        const version = tab?.version ?? this.currentVersion;
        await this.openDocumentIfNeeded(lspUri, lspContent, version);
        await this.lspClient.notifyTextChange(lspUri, lspContent, version);
        await this.lspClient.notifyTextSave(lspUri, lspContent);
      }
    }
  }

  private applyEdit(text: string, edit: { from: number; to: number; insert: string }): string {
    return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  }

  private async applyTypography(
    config: DocumentTypography,
    target: "document" | "template"
  ): Promise<void> {
    if (!this.activeFilePath) return;
    try {
      if (target === "document") {
        const editor = this.editorInstance;
        const edit = typographyEdit(editor.state.doc.toString(), config);
        editor.dispatch({
          changes: edit,
          selection: { anchor: edit.from },
          scrollIntoView: true,
          userEvent: "input"
        });
        await this.saveActiveFile();
        editor.focus();
        return;
      }

      const activeText = this.editorInstance.state.doc.toString();
      const hasExistingBlock = activeText.includes("// typstry:typography:start");
      const detectedTemplateFunc = findTemplateFunctionName(activeText);

      if (hasExistingBlock || detectedTemplateFunc) {
        const funcName = detectedTemplateFunc || "typstry-typography";
        const edit = templateTypographyEdit(activeText, funcName, config);
        if (edit) {
          const editor = this.editorInstance;
          editor.dispatch({
            changes: {
              from: edit.from,
              to: edit.to,
              insert: edit.insert
            },
            selection: { anchor: edit.from },
            scrollIntoView: true,
            userEvent: "input"
          });
          await this.saveActiveFile();
          editor.focus();
          this.setLspStatus({ kind: "preview-ready", message: "Typography applied to template" });
          await this.refreshActivePreviewRoot();
          return;
        }
      }

      const mainPath = this.previewMainPath ?? this.activeFilePath;
      const mainText = await this.workspaceText(mainPath);
      const application = findLocalTemplateApplication(mainText);
      let updatedLocalTemplate = false;

      if (application) {
        const candidate = await join(await dirname(mainPath), application.importPath);
        const relativeToWorkspace = this.workspaceRootPath
          ? relativeFilePath(this.workspaceRootPath, candidate)
          : "";
        const insideWorkspace = !this.workspaceRootPath
          || relativeToWorkspace !== null;
        if (insideWorkspace && await invoke<boolean>("workspace_path_exists", { path: candidate })) {
          const templateText = await this.workspaceText(candidate);
          const edit = templateTypographyEdit(templateText, application.functionName, config);
          if (edit) {
            await this.writeWorkspaceText(candidate, this.applyEdit(templateText, edit));
            updatedLocalTemplate = true;
          }
        }
      }

      if (!updatedLocalTemplate) {
        const mainDirectory = await dirname(mainPath);
        const templatePath = await join(mainDirectory, "typstry-template.typ");
        const exists = await invoke<boolean>("workspace_path_exists", { path: templatePath });
        let templateText = exists ? await this.workspaceText(templatePath) : newTypographyTemplate(config);
        if (exists) {
          const edit = templateTypographyEdit(templateText, "typstry-typography", config);
          templateText = edit ? this.applyEdit(templateText, edit) : newTypographyTemplate(config);
        }
        await this.writeWorkspaceText(templatePath, templateText);

        const applicationEdit = ensureTypographyTemplateApplication(mainText);
        if (applicationEdit.insert || applicationEdit.from !== applicationEdit.to) {
          await this.writeWorkspaceText(mainPath, this.applyEdit(mainText, applicationEdit));
        }
      }

      this.setLspStatus({ kind: "preview-ready", message: "Typography applied to template" });
      await this.refreshActivePreviewRoot();
      this.editorInstance.focus();
    } catch (error) {
      this.appendLspLog({
        kind: "error",
        source: "typography",
        message: `Failed to apply template typography: ${String(error)}`
      });
      await message(String(error), { title: "Unable to apply typography", kind: "error" });
    }
  }

  private applyPreviewTargetToTab(tab: EditorTab, target: PreviewTarget): void {
    let mappedTarget = target;
    if (this.settingsController.value.preview.khmerRenderPreparation) {
      mappedTarget = {
        ...target,
        rootPath: this.mapToCachePath(target.rootPath),
        mainPath: this.mapToCachePath(target.mainPath)
      };
    }
    const style = previewRefreshStyle(this.settingsController.value.preview.renderMode);
    const identity = mappedTarget.rootPath ? previewSessionIdentity(mappedTarget.rootPath, style) : null;
    tab.previewRootPath = mappedTarget.rootPath;
    tab.previewMainPath = mappedTarget.mainPath;
    tab.previewTaskId = identity?.taskId ?? null;
    tab.previewSessionKey = identity?.key ?? null;
    tab.previewImported = mappedTarget.imported;
    tab.previewStandalone = target.standalone;
    this.previewRootPath = tab.previewRootPath;
    this.previewMainPath = tab.previewMainPath;
    this.previewTaskId = tab.previewTaskId;
    this.previewSessionKey = tab.previewSessionKey;
    this.previewImported = tab.previewImported;
    this.previewStandalone = tab.previewStandalone;
  }

  private capturePreviewSession(): PreviewSessionState {
    return {
      previewRootPath: this.previewRootPath,
      previewMainPath: this.previewMainPath,
      previewTaskId: this.previewTaskId,
      previewSessionKey: this.previewSessionKey,
      previewImported: this.previewImported,
      previewStandalone: this.previewStandalone
    };
  }

  private captureCurrentMainSessionForImportedTarget(target: PreviewTarget): PreviewSessionState | null {
    if (!target.imported || !target.mainPath || !this.previewRootPath || !this.previewSessionKey) {
      return null;
    }
    const mappedMainPath = this.settingsController.value.preview.khmerRenderPreparation
      ? this.mapToCachePath(target.mainPath)
      : target.mainPath;
    if (!mappedMainPath) return null;
    const mainKey = filePathKey(mappedMainPath);
    const currentRootMatchesMain = filePathKey(this.previewRootPath) === mainKey;
    const currentMainMatchesMain = this.previewMainPath
      ? filePathKey(this.previewMainPath) === mainKey
      : false;
    return currentRootMatchesMain || currentMainMatchesMain
      ? this.capturePreviewSession()
      : null;
  }

  private applyPreviewSessionToTab(tab: EditorTab, session: PreviewSessionState): void {
    tab.previewRootPath = session.previewRootPath;
    tab.previewMainPath = session.previewMainPath;
    tab.previewTaskId = session.previewTaskId;
    tab.previewSessionKey = session.previewSessionKey;
    tab.previewImported = session.previewImported;
    tab.previewStandalone = session.previewStandalone;
    this.previewRootPath = session.previewRootPath;
    this.previewMainPath = session.previewMainPath;
    this.previewTaskId = session.previewTaskId;
    this.previewSessionKey = session.previewSessionKey;
    this.previewImported = session.previewImported;
    this.previewStandalone = session.previewStandalone;
  }

  private async rootRelativeTypstPath(path: string): Promise<string | null> {
    if (!this.workspaceRootPath) return null;
    const value = relativeFilePath(this.workspaceRootPath, path);
    if (value === null) return null;
    return `/${value.replace(/\\/g, "/")}`;
  }

  private async prepareTemplateAwarePreview(
    target: PreviewTarget,
    activePath: string,
    activeContents: string
  ): Promise<PreviewTarget> {
    if (
      !this.workspaceRootPath
      || !target.imported
      || !target.standalone
      || !target.mainPath
      || !target.rootPath
      || filePathKey(target.rootPath) !== filePathKey(activePath)
    ) return target;

    try {
      const mainText = await this.workspaceText(target.mainPath);
      const application = findLocalTemplateApplication(mainText);
      if (!application) return target;
      const templatePath = await join(await dirname(target.mainPath), application.importPath);
      if (!await invoke<boolean>("workspace_path_exists", { path: templatePath })) return target;
      const templateRootPath = await this.rootRelativeTypstPath(templatePath);
      const chapterRootPath = await this.rootRelativeTypstPath(activePath);
      if (!templateRootPath || !chapterRootPath) return target;

      const identity = previewSessionIdentity(
        activePath,
        previewRefreshStyle(this.settingsController.value.preview.renderMode)
      );
      const previewPath = await join(
        this.workspaceRootPath,
        `.${fileNameFromPath(activePath)}.${identity.taskId}.typstry-preview.typ`
      );
      const previewSource = templatePreviewSource(application, templateRootPath, chapterRootPath, activeContents);
      const existingSource = await invoke<string>("read_workspace_file", { path: previewPath }).catch(() => null);
      if (existingSource !== previewSource) {
        await invoke("save_workspace_file", { path: previewPath, contents: previewSource });
      }
      if (this.settingsController.value.preview.khmerRenderPreparation) {
        await this.getLspUriAndContent(previewPath, previewSource);
      }
      return { ...target, rootPath: previewPath };
    } catch (error) {
      this.appendLspLog({
        kind: "warning",
        source: "preview",
        message: `Using direct standalone preview because the main template could not be reused: ${String(error)}`
      });
      return target;
    }
  }

  private async openDocumentIfNeeded(uri: string, text: string, version: number): Promise<void> {
    if (this.openedDocumentUris.has(uri)) return;
    await this.lspClient.openTextDocument(uri, text, version);
    this.openedDocumentUris.add(uri);
  }

  private async updatePinnedMain(path: string | null, force = false): Promise<boolean> {
    if (!this.lspReady || !this.lspClient) return false;
    let targetPath = path;
    if (this.settingsController.value.preview.khmerRenderPreparation && path) {
      targetPath = this.mapToCachePath(path);
    }
    if (!force && filePathKey(this.pinnedLspMainPath ?? "") === filePathKey(targetPath ?? "")) return false;
    try {
      await this.lspClient.pinMain(targetPath);
      this.pinnedLspMainPath = targetPath;
      return true;
    } catch (error) {
      this.appendLspLog({
        kind: "warning",
        source: "lsp",
        message: `Unable to set Tinymist main-file context: ${String(error)}`
      });
      return false;
    }
  }

  private async recheckActiveDocumentAfterPin(text: string): Promise<void> {
    if (!this.activeFilePath || !this.lspReady || !this.lspClient) return;

    this.clearDiagnostics();
    const version = ++this.currentVersion;
    this.latestDocumentVersion = version;
    const activeTab = this.getActiveTab();
    if (activeTab && activeTab.path === this.activeFilePath) {
      activeTab.version = version;
      activeTab.latestVersion = version;
    }
    const lspRes = await this.getLspUriAndContent(this.activeFilePath, text);
    if (!lspRes) return;
    const { uri: lspUri, content: lspContent } = lspRes;
    await this.openDocumentIfNeeded(lspUri, lspContent, version);
    await this.lspClient.notifyTextChange(lspUri, lspContent, version);
  }

  private async renderPdfPreview(contents: string): Promise<void> {
    if (!this.activeFilePath || !this.lspReady || !this.lspClient) return;
    if (this.pdfPreviewRunning) {
      this.queuedPdfPreviewContents = contents;
      this.pdfPreviewGeneration += 1;
      return;
    }
    this.pdfPreviewRunning = true;
    const generation = ++this.pdfPreviewGeneration;
    this.setLspStatus({ kind: "syncing", message: "Compiling PDF preview..." });
    this.previewFrame.setLoading("Compiling PDF preview...");
    try {
      await this.flushPendingLspSync();
      const previewPath = this.settingsController.value.preview.khmerRenderPreparation
        ? this.mapToCachePath(this.previewMainPath ?? this.previewRootPath ?? this.activeFilePath)
        : this.previewMainPath ?? this.previewRootPath ?? this.activeFilePath;
      if (!previewPath) throw new Error("No PDF preview root is available.");
      const pdf = await this.lspClient.exportPdfToMemory(previewPath);
      if (generation !== this.pdfPreviewGeneration) return;
      this.setLspStatus({ kind: "preview-ready", message: "PDF Preview Ready" });
      await this.previewFrame.loadPdfData(pdf.data!, previewPath);
    } catch (error) {
      if (generation !== this.pdfPreviewGeneration) return;
      console.error("PDF Preview compilation failed:", error);
      this.previewFrame.setError(
        "Preview Render Failed",
        String(error)
      );
      this.setLspStatus({ kind: "error", message: "PDF compile failed" });
    } finally {
      this.pdfPreviewRunning = false;
      const queued = this.queuedPdfPreviewContents;
      this.queuedPdfPreviewContents = null;
      if (queued !== null && queued !== contents) void this.renderPdfPreview(queued);
    }
  }

  private schedulePdfPreview(contents: string) {
    if (this.settingsController.value.preview.renderMode !== "on-type") return;
    if (this.pdfPreviewTimer) window.clearTimeout(this.pdfPreviewTimer);
    this.pdfPreviewTimer = window.setTimeout(() => {
      this.pdfPreviewTimer = null;
      if (this.activeFilePath) {
        void this.renderPdfPreview(contents);
      }
    }, 250);
  }

  private handleContentMutation(rawText: string) {
    if (this.activeFilePath && this.activeFilePath.toLowerCase().endsWith(".typ")) {
      void this.documentOutlineController.update(
        this.activeFilePath, 
        rawText, 
        this.workspaceRootPath || "", 
        async (p) => {
          try {
            return await invoke<string>("read_workspace_file", { path: p });
          } catch {
            return null;
          }
        }
      );
    }
    if (!this.isLoadingFile) {
      this.updateActiveTabContent(rawText);
    }

    if (!this.isLoadingFile && this.activeFilePath && this.lspReady && this.lspClient) {
      const version = ++this.currentVersion;
      this.latestDocumentVersion = version;
      const activeTab = this.getActiveTab();
      if (activeTab && activeTab.path === this.activeFilePath) {
        activeTab.version = version;
        activeTab.latestVersion = version;
      }
      if (this.previewImported && allowsStandalonePreview(rawText) !== this.previewStandalone) {
        void this.refreshActivePreviewRoot();
      }
      this.pendingLspSyncPath = this.activeFilePath;
      this.pendingLspSyncText = rawText;
      this.pendingLspSyncVersion = version;
      this.setLspStatus({ kind: "sync-pending", message: "Preview update queued" });

      if (this.pendingLspSyncTimer) {
        window.clearTimeout(this.pendingLspSyncTimer);
      }

      this.pendingLspSyncTimer = window.setTimeout(
        () => void this.flushPendingLspSync(),
        this.lspSyncDebounceMs
      );
    }
    if (!this.isLoadingFile && this.activeFilePath && this.activeFilePath.toLowerCase().endsWith(".typ")) {
      this.schedulePdfPreview(rawText);
    }
  }

  private async flushPendingLspSync(): Promise<void> {
    if (this.pendingLspSyncTimer) {
      window.clearTimeout(this.pendingLspSyncTimer);
      this.pendingLspSyncTimer = null;
    }

    if (!this.pendingLspSyncPath || this.pendingLspSyncText === null || !this.lspReady || !this.lspClient) {
      return;
    }

    const path = this.pendingLspSyncPath;
    const text = this.pendingLspSyncText;
    const pendingVersion = this.pendingLspSyncVersion;
    const requestKey = filePathKey(path);
    const expectedGeneration = (this.lspSyncRequestGenerations.get(requestKey) ?? 0) + 1;
    this.lspSyncRequestGenerations.set(requestKey, expectedGeneration);

    this.pendingLspSyncPath = null;
    this.pendingLspSyncText = null;
    this.pendingLspSyncVersion = null;

    this.setLspStatus({ kind: "syncing", message: "Syncing preview" });
    this.previewSyncController.reset();
    if (this.workspaceRootPath && this.previewStandalone && this.settingsController.value.preview.renderMode === "on-type") {
      let target = await invoke<PreviewTarget>("resolve_preview_main", {
        filePath: path,
        workspaceRootPath: this.workspaceRootPath,
        fileContents: text,
        pinnedMainPath: this.pinnedMainFilePath
      });
      target = await this.prepareTemplateAwarePreview(target, path, text);
    }
    
    if (this.lspSyncRequestGenerations.get(requestKey) !== expectedGeneration) {
      return;
    }

    const version = pendingVersion ?? ++this.currentVersion;
    this.latestDocumentVersion = version;
    const activeTab = this.getActiveTab();
    if (activeTab && activeTab.path === path) {
      activeTab.version = version;
      activeTab.latestVersion = version;
    }
    const lspRes = await this.getLspUriAndContent(path, text);
    if (!lspRes) return;
    const { uri: lspUri, content: lspContent } = lspRes;
    await this.openDocumentIfNeeded(lspUri, lspContent, version);
    await this.lspClient.notifyTextChange(lspUri, lspContent, version);
    window.setTimeout(() => {
      if (this.lspReady && !this.pendingLspSyncTimer && this.pendingLspSyncText === null) {
        this.setLspStatus({ kind: "preview-ready", message: "Preview update sent" });
      }
    }, 250);
  }





  private clearPendingLspSync() {
    if (this.pendingLspSyncTimer) {
      window.clearTimeout(this.pendingLspSyncTimer);
      this.pendingLspSyncTimer = null;
    }
    this.pendingLspSyncPath = null;
    this.pendingLspSyncText = null;
    this.pendingLspSyncVersion = null;
  }


  private async handleInverseSync(uri: string | undefined, position: LspSourcePosition): Promise<number> {
    if (!this.previewSyncController.hasRecentTextClick()) {
      this.appendDeveloperLog({
        kind: "warning",
        source: "inverse sync",
        message: "Ignored inverse sync because it did not originate from Typstry's docked DOM-intercepted preview."
      });
      return this.editorInstance.state.selection.main.head;
    }

    let targetPath = uri ? filePathFromUri(uri) : null;
    if (this.settingsController.value.preview.khmerRenderPreparation && targetPath) {
      targetPath = this.mapToOriginalPath(targetPath);
    }
    const existingTargetTab = targetPath
      ? this.openTabs.find((tab) => filePathKey(tab.path) === filePathKey(targetPath))
      : null;
    const resolvedTargetPath = existingTargetTab?.path ?? targetPath;
    if (resolvedTargetPath && filePathKey(resolvedTargetPath) !== filePathKey(this.activeFilePath ?? "")) {
      await this.loadFile(resolvedTargetPath, {
        preservePreviewSession: this.capturePreviewSession()
      });
    }

    if (this.activeMode === "WYSIWYM") {
      this.switchViewLayoutMode();
    }

    this.previewSyncController.clearForward();
    
    let defaultCursorPos = 0;
    if (this.settingsController.value.preview.khmerRenderPreparation && targetPath && uri) {
      const relPath = targetPath.startsWith(this.workspaceRootPath!)
        ? targetPath.substring(this.workspaceRootPath!.length).replace(/^[/\\]+/, "")
        : targetPath;
      const cacheContent = this.preparedContentsCache.get(filePathKey(targetPath))?.preparedText || "";
      defaultCursorPos = await this.mapCacheLspPositionToOriginalEditorOffset(relPath, position, cacheContent) ?? 0;
      return defaultCursorPos;
    } else {
      defaultCursorPos = this.editorPositionFromLspPosition(position) ?? 0;
      const result = this.previewSyncController.mapInversePosition(position, defaultCursorPos);
      this.reportInverseSyncResult(result, position);
      return result.cursor;
    }
  }

  private updatePreviewZoomLabel(zoomPercent = this.previewFrame.currentZoomPercent) {
    const label = document.getElementById("preview-zoom-label");
    if (label) label.textContent = `${zoomPercent}%`;
  }

  private recordStartupTiming(source: string, label: string, start: number): void {
    this.recordStartupTimingEntry({ source, label, ms: performance.now() - start });
  }

  private recordStartupTimingEntry(entry: StartupTimingEntry): void {
    this.startupTimings.push(entry);
    this.logStartupTimingToConsole(entry);
  }

  private logStartupTimingToConsole(entry: StartupTimingEntry): void {
    console.info(`[startup timing] ${entry.source}: ${entry.label} took ${entry.ms.toFixed(1)} ms`);
  }

  private async logNativeStartupTimingsToConsole(): Promise<void> {
    try {
      const nativeTimings = await invoke<StartupTimingEntry[]>("get_startup_timings");
      for (const entry of nativeTimings) {
        const key = `${entry.source}\u0000${entry.label}`;
        if (this.loggedNativeStartupTimings.has(key)) continue;
        this.loggedNativeStartupTimings.add(key);
        this.logStartupTimingToConsole(entry);
      }
    } catch (error) {
      console.warn("Failed to read native startup timings:", error);
    }
  }

  private async finishStartupInitialization(): Promise<void> {
    try {
      const providers = await this.timeStartup("finish native startup initialization", () =>
        invoke<ProviderCapabilities[]>("finish_startup_initialization")
      );
      this.spellcheckController.setProviders(providers);
      this.settingsController.setLanguageProviders(this.spellcheckController.getAllProviders());
    } catch (error) {
      console.warn("Deferred startup initialization failed:", error);
    } finally {
      void this.logNativeStartupTimingsToConsole();
      void this.settingsController.refreshSystemFonts();
    }
  }

  private timeStartupSync<T>(label: string, action: () => T): T {
    const start = performance.now();
    try {
      return action();
    } finally {
      this.recordStartupTiming("frontend startup", label, start);
    }
  }

  private async timeStartup<T>(label: string, action: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await action();
    } finally {
      this.recordStartupTiming("frontend startup", label, start);
    }
  }

  private reportPreviewInteractionStatus(status: PreviewInteractionStatus): void {
    if (!this.settingsController.value.developerMode) return;
    if (status.kind === "debug") {
      this.appendDeveloperLog({
        kind: "info",
        source: "preview iframe",
        message: status.reason ?? `Debug event for ${status.url}`
      });
      return;
    }
    if (status.kind === "installed") {
      this.setLspStatus({ kind: "preview-ready", message: "Inverse sync refinement active" });
      this.appendDeveloperLog({
        kind: "info",
        source: "inverse sync",
        message: `Preview DOM interception installed for ${status.url}`
      });
      return;
    }
    this.setLspStatus({ kind: "preview-ready", message: "Inverse sync refinement blocked" });
    this.appendDeveloperLog({
      kind: "warning",
      source: "inverse sync",
      message: `Preview DOM interception blocked for ${status.url}: ${status.reason ?? "unknown reason"}. Inverse sync will use Tinymist's raw source position only.`
    });
  }

  private reportInverseSyncResult(result: InverseSyncResult, position: LspSourcePosition): void {
    if (!this.settingsController.value.developerMode) return;
    if (result.refined) {
      this.setLspStatus({ kind: "preview-ready", message: `Inverse sync refined to line ${(result.sourceLine ?? position.line) + 1}` });
      this.appendDeveloperLog({
        kind: "info",
        source: "inverse sync",
        message: `Refined preview click: line ${position.line + 1}, fallback offset ${result.fallback}, source offset ${result.sourceOffset}, preview offset ${result.previewOffset}/${result.previewTextLength}, sample "${result.clickedTextSample ?? ""}".`
      });
      return;
    }
    this.setLspStatus({ kind: "preview-ready", message: `Inverse sync fallback: ${result.reason}` });
    this.appendDeveloperLog({
      kind: "warning",
      source: "inverse sync",
      message: `Fallback used (${result.reason}): line ${position.line + 1}, fallback offset ${result.fallback}, preview offset ${result.previewOffset ?? "n/a"}/${result.previewTextLength ?? "n/a"}, sample "${result.clickedTextSample ?? ""}".`
    });
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

  private async handleLspDiagnostics(uri: string, diagnostics: LspDiagnostic[], version?: number) {
    const originalPath = this.mapToOriginalPath(filePathFromUri(uri));
    const isActive = this.activeFilePath && filePathKey(originalPath) === filePathKey(this.activeFilePath);

    const isPackageFile = originalPath.toLowerCase().includes("typst/packages") || 
                          originalPath.toLowerCase().includes("typst\\packages") ||
                          originalPath.toLowerCase().includes("packages/preview") ||
                          originalPath.toLowerCase().includes("packages\\preview");
    if (isPackageFile) {
      if (isActive) {
        this.editorInstance.dispatch({
          effects: setEditorDiagnosticsEffect.of([])
        });
      }
      return;
    }

    const filteredDiagnostics = diagnostics.filter(diagnostic => {
      if (diagnostic.message.includes("cannot export multiple images without a page number template")) return false;
      if (!isActive) return true;
      if (!/label.*does not exist|unknown label/i.test(diagnostic.message)) return true;
      const externalLabels = this.previewImported && this.previewStandalone
        ? new Set(externalReferenceLabels(this.editorInstance.state.doc.toString()))
        : new Set<string>();
      return ![...externalLabels].some(label =>
        diagnostic.message.includes(label) || this.diagnosticSourceText(diagnostic).includes(`@${label}`)
      );
    });

    if (isActive) {
      if (!this.shouldAcceptLspDiagnostics(uri, originalPath, version)) return;

      const editorDiagnostics: EditorDiagnostic[] = [];
      const staleDiagnostics = new Set<LspDiagnostic>();
      const relPath = originalPath.startsWith(this.workspaceRootPath!)
        ? originalPath.substring(this.workspaceRootPath!.length).replace(/^[/\\]+/, "")
        : originalPath;
      const cacheContent = this.preparedContentsCache.get(filePathKey(originalPath))?.preparedText || "";

      for (const diagnostic of filteredDiagnostics) {
        let from: number | null = null;
        let to: number | null = null;
        if (this.settingsController.value.preview.khmerRenderPreparation) {
          from = await this.mapCacheLspPositionToOriginalEditorOffset(relPath, diagnostic.range.start, cacheContent);
          to = await this.mapCacheLspPositionToOriginalEditorOffset(relPath, diagnostic.range.end, cacheContent);
        } else {
          from = this.editorPositionFromLspPosition(diagnostic.range.start);
          to = this.editorPositionFromLspPosition(diagnostic.range.end);
        }
        if (from !== null && to !== null) {
          if (looksLikeStalePrefixDiagnostic(this.editorInstance.state.doc, from, Math.max(from, to), diagnostic.message)) {
            staleDiagnostics.add(diagnostic);
            continue;
          }
          editorDiagnostics.push({
            from,
            to: Math.max(from, to),
            severity: this.diagnosticSeverityFromLsp(diagnostic.severity),
            message: diagnostic.message
          });
        }
      }

      if (!this.shouldAcceptLspDiagnostics(uri, originalPath, version)) return;

      this.editorInstance.dispatch({
        effects: setEditorDiagnosticsEffect.of(editorDiagnostics)
      });

      this.logConsoleController.setDiagnostics(originalPath, filteredDiagnostics
        .filter(diagnostic => !staleDiagnostics.has(diagnostic))
        .map((diagnostic) => this.logEntryFromDiagnostic(uri, diagnostic)));
    } else {
      this.logConsoleController.setDiagnostics(originalPath, filteredDiagnostics.map((diagnostic) => this.logEntryFromDiagnostic(uri, diagnostic)));
    }

    if (this.logConsoleController.getErrorCount() > 0) {
      this.previewFrame.setError("Preview Render Failed", "The live preview cannot be updated because of compile errors.\nPlease check the Problems panel or Log Console for details.");
    } else {
      this.previewFrame.clearErrorOverlay();
    }
  }



  private diagnosticSourceText(diagnostic: LspDiagnostic): string {
    const from = this.editorPositionFromLspPosition(diagnostic.range.start);
    const to = this.editorPositionFromLspPosition(diagnostic.range.end);
    if (from === null || to === null) return "";
    return this.editorInstance.state.doc.sliceString(from, Math.max(from, to));
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
    this.logConsoleController.appendLog({
      kind: entry.kind,
      source: entry.source ?? "tinymist",
      message: entry.message,
      channel: "lsp"
    });
  }

  private appendDeveloperLog(entry: LspLogEntry) {
    if (!this.settingsController.value.developerMode) return;
    this.logConsoleController.appendLog({
      kind: entry.kind,
      source: entry.source ?? "developer",
      message: entry.message,
      channel: "dev"
    });
  }

  private updateSpellcheckLog(issues: readonly SpellingIssue[]): void {
    const filePath = this.activeFilePath;
    if (!filePath || !this.editorInstance) {
      this.logConsoleController.setSpellcheckIssues([]);
      return;
    }
    const doc = this.editorInstance.state.doc;
    this.logConsoleController.setSpellcheckIssues(issues.map(issue => {
      const offset = Math.max(0, Math.min(issue.from, doc.length));
      const line = doc.lineAt(offset);
      return {
        kind: issue.ignored ? "info" : "warning",
        channel: "spellcheck",
        counted: !issue.ignored,
        source: issue.provider,
        filePath,
        fileName: fileNameFromPath(filePath),
        message: `${issue.ignored ? "Ignored unknown word" : "Unknown word"}: “${issue.sourceText}”`,
        line: line.number,
        column: offset - line.from + 1,
        offset,
        toOffset: Math.max(offset, Math.min(issue.to, doc.length))
      };
    }));
  }

  private shouldAcceptLspDiagnostics(_uri: string, originalPath: string, version?: number): boolean {
    if (typeof version === "number") {
      return version >= this.latestDocumentVersion;
    }

    if (this.pendingLspSyncPath && filePathKey(this.pendingLspSyncPath) === filePathKey(originalPath)) {
      return false;
    }
    // Tinymist currently omits `params.version` from diagnostics. Once the
    // active document has no unsent edit, the newest publication for that URI
    // must be accepted and replace the previous diagnostics, as required by
    // the LSP publication model. Source-aware stale-prefix filtering below
    // handles the short-lived completion race without discarding real errors.
    return true;
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
    if (!entry.line && entry.offset === undefined) return;
    if (entry.filePath && filePathKey(entry.filePath) !== filePathKey(this.activeFilePath ?? "")) {
      await this.loadFile(entry.filePath);
    }
    const cursor = entry.offset === undefined
      ? this.editorPositionFromSourceLocation(entry.line ?? 1, entry.column ?? 1)
      : Math.max(0, Math.min(entry.offset, this.editorInstance.state.doc.length));
    const selectionEnd = entry.toOffset === undefined
      ? cursor
      : Math.max(cursor, Math.min(entry.toOffset, this.editorInstance.state.doc.length));
    this.editorInstance.dispatch({
      selection: { anchor: cursor, head: selectionEnd },
      effects: EditorView.scrollIntoView(cursor, { y: "center" })
    });
    this.editorInstance.focus();
  }

  private async navigateToLspLocation(uri: string, line: number, character: number) {
    let filePath = filePathFromUri(uri);
    if (this.settingsController.value.preview.khmerRenderPreparation) {
      filePath = this.mapToOriginalPath(filePath);
    }
    if (filePath !== this.activeFilePath) {
      await this.loadFile(filePath);
    }
    
    let cursor = 0;
    if (this.settingsController.value.preview.khmerRenderPreparation && this.lspClient) {
      const relPath = filePath.startsWith(this.workspaceRootPath!)
        ? filePath.substring(this.workspaceRootPath!.length).replace(/^[/\\]+/, "")
        : filePath;
      const cacheContent = this.preparedContentsCache.get(filePathKey(filePath))?.preparedText || "";
      cursor = await this.mapCacheLspPositionToOriginalEditorOffset(relPath, { line, character }, cacheContent) ?? 0;
    } else if (this.lspClient) {
      cursor = this.lspClient.editorPositionFromLspPosition({ line, character });
    } else {
      const doc = this.editorInstance.state.doc;
      const lineInfo = doc.line(Math.max(1, Math.min(line + 1, doc.lines)));
      cursor = Math.max(lineInfo.from, Math.min(lineInfo.from + character, lineInfo.to));
    }
    
    this.editorInstance.dispatch({
      selection: { anchor: cursor },
      effects: EditorView.scrollIntoView(cursor, { y: "center" })
    });
    this.editorInstance.focus();
  }

  private async navigateToOutlineHeading(heading: DocumentHeading) {
    const activeTab = this.getActiveTab();
    if (activeTab?.temporary) {
      void this.promoteToPermanent(activeTab);
    }

    if (heading.filePath !== this.activeFilePath) {
      await this.loadFile(heading.filePath);
    }
    if (this.activeMode === "WYSIWYM") this.switchViewLayoutMode();
    const currentHeading = this.documentOutlineController.findHeading(heading.id) ?? heading;
    const cursor = Math.max(0, Math.min(currentHeading.textFrom, this.editorInstance.state.doc.length));
    this.previewSyncController.clearForward();
    this.editorInstance.dispatch({
      selection: { anchor: cursor },
      effects: EditorView.scrollIntoView(cursor, { y: "start", yMargin: 28 })
    });
    this.documentOutlineController.setCursorPosition(cursor, this.activeFilePath);
    this.editorInstance.focus();
    if (currentHeading.previewPosition) {
      this.previewFrame.scrollToPage(currentHeading.previewPosition.page_no);
    } else {
      const previewPos = this.documentOutlineController.previewPositionAt(cursor);
      if (previewPos) {
        this.previewFrame.scrollToPage(previewPos.page_no);
      }
    }
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
      pinnedMainFilePath: this.pinnedMainFilePath,
      openTabs: this.openTabs.map(tab => ({
        path: tab.path,
        selectionAnchor: tab.selectionAnchor,
        selectionHead: tab.selectionHead,
        scrollTop: tab.scrollTop,
        scrollLeft: tab.scrollLeft,
        foldRanges: tab.foldRanges
      })),
      inputContainerWidthPct: inputContainer?.style.width ? parseFloat(inputContainer.style.width) : DEFAULT_INPUT_WIDTH_PCT,
      explorerSidebarWidthPx: explorerSidebar?.style.width ? parseInt(explorerSidebar.style.width, 10) : DEFAULT_EXPLORER_WIDTH_PX
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

      if (state.pinnedMainFilePath) {
        this.pinnedMainFilePath = state.pinnedMainFilePath;
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
             const contents = isBinaryImagePath(tabInfo.path)
               ? await invoke<string>("read_workspace_file_as_base64", { path: tabInfo.path })
               : normalizeEditorText(await invoke<string>("read_workspace_file", { path: tabInfo.path }));
             this.openTabs.push({
               path: tabInfo.path,
               content: contents,
               savedContent: contents,
               isDirty: false,
               previewRootPath: null,
               previewMainPath: null,
               previewTaskId: null,
               previewSessionKey: null,
               previewImported: false,
               previewStandalone: true,
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

  private async handleWorkspaceChange(change: WorkspaceChange): Promise<void> {
    const workspaceRoot = this.workspaceRootPath;
    if (!workspaceRoot || filePathKey(change.rootPath) !== filePathKey(workspaceRoot)) return;

    // Ignore changes that are only inside the cache (.typstry) directory to prevent infinite loops and race conditions
    const hasExternalChanges = change.paths.some(path => {
      const relPath = path.startsWith(workspaceRoot)
        ? path.substring(workspaceRoot.length)
        : path;
      const cleanRel = relPath.replace(/^[/\\]+/, "").replace(/\\/g, "/");
      return !cleanRel.startsWith(".typstry");
    });
    
    if (!hasExternalChanges) return;

    await this.prepareRenderProjectIfNeeded();

    await Promise.all([
      this.explorer.loadWorkspace(workspaceRoot),
      this.reloadOpenFilesFromDisk()
    ]);
    if (this.workspaceRootPath !== workspaceRoot) return;

    await this.refreshActivePreviewRoot();

    if (this.lspReady && this.lspClient) {
      const defaultType: 1 | 2 | 3 = change.kind === "create" ? 1 : change.kind === "remove" ? 3 : 2;
      const lastPathIndex = change.paths.length - 1;
      const changes = change.paths.map((path, index) => {
        let targetPath = path;
        if (this.settingsController.value.preview.khmerRenderPreparation) {
          targetPath = this.mapToCachePath(path)!;
        }
        return {
          uri: filePathToUri(targetPath),
          type: change.kind === "rename" && change.paths.length > 1
            ? (index === lastPathIndex ? 1 : 3) as 1 | 3
            : defaultType
        };
      });
      await this.lspClient.notifyWorkspaceFilesChanged(changes);
    }
  }

  private async reloadOpenFilesFromDisk(): Promise<void> {
    for (const tab of [...this.openTabs]) {
      const pathKey = filePathKey(tab.path);
      const exists = await invoke<boolean>("workspace_path_exists", { path: tab.path });
      if (!exists) {
        if (tab.isDirty) {
          this.reportExternalConflict(tab.path, "was removed outside Typstry");
        } else {
          this.externalConflictPaths.delete(pathKey);
          await this.closeEditorTab(tab.path, true);
        }
        continue;
      }

      let contents: string;
      try {
        contents = isBinaryImagePath(tab.path)
          ? await invoke<string>("read_workspace_file_as_base64", { path: tab.path })
          : normalizeEditorText(await invoke<string>("read_workspace_file", { path: tab.path }));
      } catch (error) {
        console.warn(`Unable to reload ${tab.path}:`, error);
        continue;
      }

      if (contents === tab.savedContent) {
        this.externalConflictPaths.delete(pathKey);
        continue;
      }
      if (contents === tab.content) {
        tab.savedContent = contents;
        tab.isDirty = false;
        this.externalConflictPaths.delete(pathKey);
        this.renderEditorTabs();
        continue;
      }
      if (tab.isDirty) {
        this.reportExternalConflict(tab.path, "changed outside Typstry");
        continue;
      }

      this.externalConflictPaths.delete(pathKey);
      await this.applyExternalFileContent(tab, contents);
    }
  }

  private async applyExternalFileContent(tab: EditorTab, contents: string): Promise<void> {
    const isActive = this.activeFilePath !== null && filePathKey(tab.path) === filePathKey(this.activeFilePath);
    tab.content = contents;
    tab.savedContent = contents;
    tab.isDirty = false;

    if (!isActive) {
      this.renderEditorTabs();
      return;
    }

    if (isBinaryImagePath(tab.path)) {
      const img = document.getElementById("image-viewer-img") as HTMLImageElement;
      if (img) img.src = contents;
      this.renderEditorTabs();
      return;
    }

    const selection = this.editorInstance.state.selection.main;
    this.isLoadingFile = true;
    try {
      this.editorInstance.dispatch({
        changes: { from: 0, to: this.editorInstance.state.doc.length, insert: contents },
        selection: {
          anchor: Math.min(selection.anchor, contents.length),
          head: Math.min(selection.head, contents.length)
        }
      });
    } finally {
      this.isLoadingFile = false;
    }

    this.renderEditorTabs();
    this.editorFontManager.updateDocument(contents);
    if (tab.path.toLowerCase().endsWith(".typ")) {
      void this.documentOutlineController.update(
        tab.path, 
        contents, 
        this.workspaceRootPath || "", 
        async (p) => {
          try {
            return await invoke<string>("read_workspace_file", { path: p });
          } catch {
            return null;
          }
        }
      );
      this.documentOutlineController.setCursorPosition(this.editorInstance.state.selection.main.head, this.activeFilePath);
    } else {
      this.documentOutlineController.clear();
    }
    if (this.activeMode === "WYSIWYM") this.mapMarkupToWysiwym(contents);

    const version = ++this.currentVersion;
    this.latestDocumentVersion = version;
    tab.version = version;
    tab.latestVersion = version;
    if (this.lspReady && this.lspClient) {
      const lspRes = await this.getLspUriAndContent(tab.path, contents);
      if (lspRes) {
        const { uri: lspUri, content: lspContent } = lspRes;
        await this.openDocumentIfNeeded(lspUri, lspContent, version);
        await this.lspClient.notifyTextChange(lspUri, lspContent, version);
        await this.lspClient.notifyTextSave(lspUri, lspContent);
        this.setLspStatus({ kind: "preview-ready", message: "Reloaded external file change" });
      }
    }
  }

  private noMainFileMessage(): string {
    return (
      `<div class="preview-disabled-placeholder">` +
      `<div class="preview-disabled-title" style="color:#3db489;font-size:18px;margin-bottom:12px;">No Main File Selected</div>` +
      `<div class="preview-disabled-msg">Right-click any <code style="background:var(--ui-hover);padding:1px 5px;border-radius:3px;">.typ</code> file in the Explorer and choose <strong>Set as Main File</strong> to enable live preview and export.</div>` +
      `</div>`
    );
  }

  private disabledPreviewMessage(): string {
    return (
      `<div class="preview-disabled-placeholder">` +
      `<div class="preview-disabled-icon">🚫</div>` +
      `<div class="preview-disabled-title">Preview Unavailable</div>` +
      `<div class="preview-disabled-msg">This file is not imported or included by the main document. Only the main file and its dependencies are previewed.</div>` +
      `<div class="preview-disabled-hint">// standalone-preview</div>` +
      `<div class="preview-disabled-msg" style="margin-top: 8px; font-size: 12px; opacity: 0.75;">Add this directive at the top of the file to preview it standalone.</div>` +
      `</div>`
    );
  }

  private renderInteractiveImageViewer(src: string) {
    const previewActions = document.querySelector(".preview-actions");
    previewActions?.classList.add("hidden");

    this.previewFrame.setMessage(
      `<div id="interactive-image-container" style="position:relative;width:100%;height:100%;background:var(--ui-bg);overflow:hidden;display:flex;align-items:center;justify-content:center;user-select:none;box-sizing:border-box;">` +
      `<img id="interactive-image-el" alt="Image preview" draggable="false" style="max-width:none;max-height:none;position:absolute;cursor:grab;user-select:none;will-change:transform;visibility:hidden;" />` +
      `<button id="interactive-image-fit-btn" style="position:absolute;bottom:16px;right:16px;z-index:10;background:#3db489;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-family:var(--font-family-sans);font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,0.15);font-weight:bold;">Fit to Window</button>` +
      `</div>`
    );

    const container = document.getElementById("interactive-image-container");
    const img = document.getElementById("interactive-image-el") as HTMLImageElement | null;
    const fitBtn = document.getElementById("interactive-image-fit-btn");

    if (!container || !img) return;

    let scale = 1;
    let x = 0;
    let y = 0;
    let isDragging = false;
    let startX = 0;
    let startY = 0;

    const updateTransform = () => {
      img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    };

    const resetToFit = () => {
      const cWidth = container.clientWidth;
      const cHeight = container.clientHeight;
      const iWidth = img.naturalWidth;
      const iHeight = img.naturalHeight;
      if (cWidth <= 0 || cHeight <= 0 || iWidth <= 0 || iHeight <= 0) return;

      const scaleX = cWidth / iWidth;
      const scaleY = cHeight / iHeight;
      scale = Math.min(scaleX, scaleY, 1);
      x = 0;
      y = 0;
      updateTransform();
      img.style.visibility = "visible";
    };

    img.onload = () => {
      requestAnimationFrame(resetToFit);
    };
    img.onerror = () => this.previewFrame.setError(
      "Image preview unavailable",
      "Typstry could not decode this image."
    );
    img.src = src;

    container.addEventListener("wheel", (e) => {
      e.preventDefault();
      const zoomFactor = 1.1;
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left - rect.width / 2;
      const mouseY = e.clientY - rect.top - rect.height / 2;

      const prevScale = scale;
      if (e.deltaY < 0) {
        scale = Math.min(scale * zoomFactor, 20);
      } else {
        scale = Math.max(scale / zoomFactor, 0.05);
      }

      x = mouseX - (mouseX - x) * (scale / prevScale);
      y = mouseY - (mouseY - y) * (scale / prevScale);
      updateTransform();
    }, { passive: false });

    container.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      img.style.cursor = "grabbing";
      startX = e.clientX - x;
      startY = e.clientY - y;
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      x = e.clientX - startX;
      y = e.clientY - startY;
      updateTransform();
    });

    window.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        img.style.cursor = "grab";
      }
    });

    fitBtn?.addEventListener("click", () => {
      resetToFit();
    });
  }

  private async refreshActivePreviewRoot(): Promise<void> {
    if (!this.activeFilePath) return;
    const ext = this.activeFilePath.split('.').pop()?.toLowerCase();
    if (ext === "svg") {
      this.previewFrame.setMessage(
        `<div style="display:flex;align-items:center;justify-content:center;height:100%;width:100%;background:var(--ui-bg);box-sizing:border-box;padding:20px;overflow:auto;">` +
        this.editorInstance.state.doc.toString() +
        `</div>`
      );
      return;
    }
    if (isBinaryImagePath(this.activeFilePath) || ext !== "typ") {
      return;
    }
    if (!this.pinnedMainFilePath) {
      this.previewFrame.setMessage(this.noMainFileMessage());
      return;
    }
    const contents = this.editorInstance.state.doc.toString();
    let target = await invoke<PreviewTarget>("resolve_preview_main", {
      filePath: this.activeFilePath,
      workspaceRootPath: this.workspaceRootPath,
      fileContents: contents,
      pinnedMainPath: this.pinnedMainFilePath
    });
    if (target.disabled) {
      const activeTab = this.getActiveTab();
      if (activeTab) this.applyPreviewTargetToTab(activeTab, target);
      this.previewFrame.setMessage(this.disabledPreviewMessage());
      return;
    }
    target = await this.prepareTemplateAwarePreview(target, this.activeFilePath, contents);
    await this.updatePinnedMain(target.mainPath);
    const identity = target.rootPath
      ? previewSessionIdentity(target.rootPath, previewRefreshStyle(this.settingsController.value.preview.renderMode))
      : null;
    const unchanged = identity?.key === this.previewSessionKey;
    if (unchanged) return;

    const activeTab = this.getActiveTab();
    if (!activeTab) return;
    this.applyPreviewTargetToTab(activeTab, target);

    if (!target.rootPath) {
      this.previewPane.innerHTML = `<div style="padding: 20px; color: #5f6368; font-family: var(--font-family-sans);">No preview root found for this library/template file. Diagnostics are still active.</div>`;
      return;
    }

    await this.renderPdfPreview(contents);
  }

  private reportExternalConflict(path: string, reason: string): void {
    const pathKey = filePathKey(path);
    if (this.externalConflictPaths.has(pathKey)) return;
    this.externalConflictPaths.add(pathKey);
    this.appendLspLog({
      kind: "warning",
      source: "workspace",
      message: `${fileNameFromPath(path)} ${reason}; unsaved editor content was preserved.`
    });
    this.setLspStatus({ kind: "error", message: "External change conflicts with unsaved edits" });
  }

  private reportWorkspaceWatchError(error: unknown): void {
    console.error("Workspace watcher failed:", error);
    this.appendLspLog({ kind: "error", source: "workspace", message: `Workspace watcher failed: ${String(error)}` });
  }

  private async openWorkspace(selected: string) {
    if (this.workspaceRootPath && this.workspaceRootPath !== selected) {
      this.closeProject();
    }
    await invoke("cleanup_workspace_preview_files", { workspaceRootPath: selected });
    this.workspaceRootPath = selected;
    await this.prepareRenderProjectIfNeeded();
    await this.explorer.loadWorkspace(selected);
    await this.workspaceWatcher.start(selected);
    this.updateWorkspaceViewportVisibility();
    this.recentProjectsController.add(selected);
    if (this.lspClient) {
      this.setLspStatus({ kind: "starting", message: "Connecting to new workspace root..." });
      void this.lspClient.restart();
    }
    await this.restoreWorkspaceState(selected);
    // Reload explorer tree to make sure the restored pinned main file color/format is rendered
    await this.explorer.loadWorkspace(selected);
  }

  private async closeOtherTabs(pathToKeep: string) {
    const tabsToClose = this.openTabs.filter(tab => tab.path !== pathToKeep);
    for (const tab of tabsToClose) {
      await this.closeEditorTab(tab.path, false);
    }
  }

  private async restartWorkspace() {
    if (this.workspaceRootPath) {
      const currentWorkspace = this.workspaceRootPath;
      this.closeProject();
      await this.openWorkspace(currentWorkspace);
    }
  }

  private async openExamplesWorkspace(): Promise<void> {
    const button = document.getElementById("welcome-open-examples") as HTMLButtonElement | null;
    if (button) button.disabled = true;
    try {
      const examples = await invoke<ExamplesWorkspace>("prepare_examples_workspace");
      await this.openWorkspace(examples.workspacePath);
      await this.loadFile(examples.entryPath);
    } catch (error) {
      this.appendLspLog({
        kind: "error",
        source: "examples",
        message: `Failed to open examples: ${String(error)}`
      });
      await message(String(error), { title: "Unable to open examples", kind: "error" });
    } finally {
      if (button) button.disabled = false;
    }
  }

  private isPinnedMainFile(path: string): boolean {
    return this.pinnedMainFilePath !== null && filePathKey(this.pinnedMainFilePath) === filePathKey(path);
  }

  private async setPinnedMainFile(path: string | null): Promise<void> {
    this.pinnedMainFilePath = path;
    this.saveWorkspaceState();
    
    if (this.workspaceRootPath) {
      await this.explorer.loadWorkspace(this.workspaceRootPath);
    }
    
    await this.refreshActivePreviewRoot();
  }

  private closeProject() {
    this.saveWorkspaceState();
    this.pinnedMainFilePath = null;
    void this.updatePinnedMain(null, true);
    this.workspaceWatcher.stop();
    if (this.workspaceRootPath) {
      void invoke("cleanup_workspace_preview_files", { workspaceRootPath: this.workspaceRootPath });
    }
    this.externalConflictPaths.clear();
    
    this.workspaceRootPath = null;
    this.activeFilePath = null;
    this.spellcheckController.activateDocument("");
    this.previewRootPath = null;
    this.previewTaskId = null;
    this.previewSessionKey = null;
    this.previewImported = false;
    this.previewStandalone = true;
    this.openedDocumentUris.clear();
    this.openTabs = [];
    this.renderEditorTabs();
    
    // Clear editor
    this.editorInstance.dispatch({
      changes: { from: 0, to: this.editorInstance.state.doc.length, insert: "" }
    });
    
    // Clear workspace navigation
    document.getElementById("workspace-explorer-tree")!.innerHTML = "";
    this.documentOutlineController.clear();
    this.previewFrame.clear();
    
    this.setLspStatus({ kind: "ready", message: "Project closed" });
    this.updateWorkspaceViewportVisibility();
  }

  private bindGlobalEvents() {
    window.addEventListener("beforeunload", () => {
      this.workspaceWatcher.stop();
      this.saveWorkspaceState();
      this.settingsController.flush();
    });

    document.addEventListener("focusin", (e) => {
      const target = e.target as HTMLInputElement | null;
      if (target && target.tagName === "INPUT") {
        if (target.classList.contains("cm-textfield") || target.closest(".cm-search") || target.closest(".cm-panel")) {
          target.setAttribute("autocomplete", "off");
          target.setAttribute("autocorrect", "off");
          target.setAttribute("autocapitalize", "off");
          target.setAttribute("spellcheck", "false");
        }
      }
    });

    document.addEventListener("keydown", (e) => {
      const isMac = navigator.userAgent.toLowerCase().includes("mac");
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;
      const keyCode = e.code;

      if (e.key === "Escape" && document.activeElement?.closest(".cm-editor")) {
        this.spellcheckController.dismissActiveTyping();
      }
      
      // Ctrl+F12 to open devtools in dev build
      if (cmdOrCtrl && keyCode === "F12" && import.meta.env.DEV) {
        e.preventDefault();
        void invoke("open_devtools");
      }
      
      // Block common function keys (except F3 which we handle conditionally)
      if (["F5", "F6", "F7", "F11"].includes(keyCode)) {
        e.preventDefault();
      }
      
      // Block specific browser shortcuts (that we don't map below)
      if (cmdOrCtrl && ["KeyR", "KeyP", "KeyJ", "KeyU", "KeyD"].includes(keyCode)) {
        e.preventDefault();
      }
      
      // Block browser's Find/Replace shortcuts only if not in an input/textarea/editor
      if (keyCode === "F3" || (cmdOrCtrl && ["KeyF", "KeyG", "KeyH"].includes(keyCode))) {
         const active = document.activeElement;
         if (!active || (!active.classList.contains("cm-content") && active.tagName !== "INPUT" && active.tagName !== "TEXTAREA" && !active.closest('.cm-panel'))) {
             e.preventDefault();
         }
      }
      
      if (cmdOrCtrl && e.shiftKey && ["KeyI", "KeyC", "KeyF", "KeyJ", "KeyR"].includes(keyCode)) {
        e.preventDefault();
      }

      if (cmdOrCtrl && e.shiftKey && !e.altKey && keyCode === "KeyF") {
        e.preventDefault();
        void this.formatActiveDocument();
        return;
      }
      
      // App Keymappings
      if (cmdOrCtrl && !e.shiftKey && !e.altKey) {
        switch (keyCode) {
          case "KeyS":
            e.preventDefault();
            void this.saveActiveFile();
            break;
          case "KeyO":
            e.preventDefault();
            document.getElementById("action-open-folder")?.click();
            break;
          case "KeyN":
            e.preventDefault();
            document.getElementById("action-new-file")?.click();
            break;
          case "KeyB":
            e.preventDefault();
            document.getElementById("action-toggle-sidebar")?.click();
            break;
          case "KeyE":
            e.preventDefault();
            document.getElementById("action-export-pdf")?.click();
            break;
          case "KeyQ":
            e.preventDefault();
            document.getElementById("action-exit")?.click();
            break;
          case "Backquote":
            e.preventDefault();
            document.getElementById("action-toggle-logs")?.click();
            break;
        }
      }

      if (e.altKey && !cmdOrCtrl && !e.shiftKey) {
        if (keyCode === "KeyZ") {
          e.preventDefault();
          document.getElementById("action-toggle-word-wrap")?.click();
        }
      }
    });

    // TODO: Re-enable native WYSIWYM layout events when the implementation is ready.
    // listen("menu-toggle-layout", () => this.switchViewLayoutMode());
    listen("menu-toggle-log-console", () => this.logConsoleController.toggle());
    listen("menu-open-folder", async () => {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        await this.openWorkspace(selected);
      }
    });

    document.getElementById("preview-zoom-out-btn")?.addEventListener("click", () => {
      this.previewFrame.zoomOut();
      this.updatePreviewZoomLabel();
    });

    document.getElementById("preview-zoom-in-btn")?.addEventListener("click", () => {
      this.previewFrame.zoomIn();
      this.updatePreviewZoomLabel();
    });

    this.updatePreviewZoomLabel();

    document.getElementById("action-open-folder")?.addEventListener("click", async () => {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        await this.openWorkspace(selected);
      }
    });
    
    document.getElementById("action-restart-workspace")?.addEventListener("click", () => {
      void this.restartWorkspace();
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
        
        let targetFilePath = this.activeFilePath;
        let targetContent = content;
        
        if (this.settingsController.value.preview.khmerRenderPreparation) {
          const lspRes = await this.getLspUriAndContent(this.activeFilePath, content);
          if (lspRes) {
            targetFilePath = filePathFromUri(lspRes.uri);
            targetContent = lspRes.content;
          }
        }

        try {
          const pdfPath = await invoke<string>("compile_typst_document", {
            sourceCode: targetContent,
            filePath: targetFilePath
          });
          
          let finalPdfPath = pdfPath;
          if (this.settingsController.value.preview.khmerRenderPreparation) {
            const originalPdfPath = this.activeFilePath.replace(/\.typ$/, ".pdf");
            await invoke("copy_workspace_file", { source: pdfPath, dest: originalPdfPath });
            await invoke("move_to_trash", { path: pdfPath });
            finalPdfPath = originalPdfPath;
          }
          
          this.setLspStatus({ kind: "preview-ready", message: `Exported to ${finalPdfPath}` });
        } catch (error) {
          this.setLspStatus({ kind: "error", message: `Export failed: ${error}` });
        }
      }
    });

    document.getElementById("action-export-zip")?.addEventListener("click", async () => {
      if (!this.workspaceRootPath) {
        alert("Please open a project workspace first.");
        return;
      }

      try {
        const folderName = this.workspaceRootPath.split(/[/\\]/).pop() || "workspace";
        const selected = await save({
          filters: [{
            name: "ZIP Archive",
            extensions: ["zip"]
          }],
          defaultPath: `${folderName}.zip`
        });

        if (selected) {
          this.setLspStatus({ kind: "running", message: "Exporting Workspace..." });
          await invoke("export_workspace_as_zip", {
            workspacePath: this.workspaceRootPath,
            zipPath: selected
          });
          this.setLspStatus({ kind: "preview-ready", message: `Workspace exported to ${selected}` });
        }
      } catch (error) {
        this.setLspStatus({ kind: "error", message: `Export failed: ${error}` });
        await message(String(error), { title: "ZIP Export Failed", kind: "error" });
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

    document.getElementById("action-format-document")?.addEventListener("click", () => {
      void this.formatActiveDocument();
    });

    document.getElementById("action-toggle-word-wrap")?.addEventListener("click", () => {
      document.getElementById("word-wrap-toggle")?.click();
    });

    document.getElementById("action-toggle-sidebar")?.addEventListener("click", () => {
      this.toggleSidebar();
    });

    document.getElementById("sidebar-toggle-button")?.addEventListener("click", () => {
      this.toggleSidebar();
    });

    document.getElementById("action-restore-default-layout")?.addEventListener("click", () => {
      this.restoreDefaultLayout();
    });

    document.getElementById("action-clear-logs")?.addEventListener("click", () => {
      this.logConsoleController.clearLogs();
    });

    document.getElementById("action-restart-lsp")?.addEventListener("click", async () => {
      this.setLspStatus({ kind: "starting", message: "Restarting LSP..." });
      const activePath = this.activeFilePath;
      this.lspReady = false;
      this.openedDocumentUris.clear();
      this.previewFrame.clear();
      this.clearPendingLspSync();
      await this.initLsp();
      if (activePath && this.openTabs.some(tab => filePathKey(tab.path) === filePathKey(activePath))) {
        this.activeFilePath = null;
        await this.activateEditorTab(activePath, false);
      }
    });

    document.getElementById("action-docs-typstry")?.addEventListener("click", () => {
      openUrl("https://github.com/sovichea/typstry");
    });

    document.getElementById("action-docs-typst")?.addEventListener("click", () => {
      openUrl("https://typst.app/docs");
    });

    // TODO: Re-enable the WYSIWYM layout menu action when the implementation is ready.
    // document.getElementById("action-toggle-layout")?.addEventListener("click", () => this.switchViewLayoutMode());
    document.getElementById("action-toggle-logs")?.addEventListener("click", () => this.logConsoleController.toggle());

    // Welcome Screen Actions
    document.getElementById("welcome-open-project")?.addEventListener("click", () => {
      document.getElementById("action-open-folder")?.click();
    });
    document.getElementById("welcome-open-examples")?.addEventListener("click", () => {
      void this.openExamplesWorkspace();
    });

    // Menu Bar Dropdown logic
    const dropdownContainers = document.querySelectorAll("#app-menus .dropdown-container");
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

    void appWindow.onCloseRequested(async (event) => {
      const hasUnsaved = this.openTabs.some(tab => tab.isDirty);
      if (hasUnsaved) {
        event.preventDefault();
        const confirmed = await confirm(
          "You have unsaved changes. Are you sure you want to close Typstry?",
          { title: "Unsaved Changes", kind: "warning" }
        );
        if (confirmed) {
          void appWindow.destroy();
        }
      }
    });

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



  private getCacheRootPath(): string | null {
    if (!this.workspaceRootPath) return null;
    return `${this.workspaceRootPath}/.typstry/cache`.replace(/\\/g, "/");
  }

  private mapToCachePath(originalPath: string | null): string | null {
    if (!originalPath || !this.workspaceRootPath) return originalPath;
    
    const cachePrefix = `${this.workspaceRootPath}/.typstry/cache/`.replace(/\\/g, "/").toLowerCase();
    const cleanPath = originalPath.replace(/\\/g, "/").toLowerCase();
    if (cleanPath.includes(cachePrefix) || cleanPath.includes("/.typstry/cache/")) {
      return originalPath;
    }

    const relPath = originalPath.startsWith(this.workspaceRootPath)
      ? originalPath.substring(this.workspaceRootPath.length)
      : originalPath;
    const cleanRel = relPath.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    return `${this.workspaceRootPath}/.typstry/cache/render/${cleanRel}`;
  }

  private mapToOriginalPath(cachePath: string): string {
    if (!this.workspaceRootPath || !this.settingsController.value.preview.khmerRenderPreparation) {
      return cachePath;
    }
    const prefix = `${this.workspaceRootPath}/.typstry/cache/render/`.replace(/\\/g, "/").toLowerCase();
    const cleanCache = cachePath.replace(/\\/g, "/").toLowerCase();
    if (cleanCache.startsWith(prefix)) {
      const relPath = cachePath.substring(prefix.length);
      return `${this.workspaceRootPath}/${relPath}`;
    }
    return cachePath;
  }

  private async getLspUriAndContent(path: string, originalContent: string): Promise<{ uri: string; content: string } | null> {
    if (!this.settingsController.value.preview.khmerRenderPreparation || !this.workspaceRootPath) {
      return { uri: filePathToUri(path), content: originalContent };
    }
    const cacheRoot = this.getCacheRootPath();
    if (!cacheRoot) {
      return { uri: filePathToUri(path), content: originalContent };
    }
    
    const key = filePathKey(path);
    const cached = this.preparedContentsCache.get(key);
    if (cached && cached.content === originalContent) {
      return {
        uri: filePathToUri(cached.generatedPath),
        content: cached.preparedText
      };
    }

    const gen = (this.lspSyncGenerations.get(key) ?? 0) + 1;
    this.lspSyncGenerations.set(key, gen);

    try {
      const res = await invoke<any>("prepare_render_file", {
        options: {
          enableKhmerZws: true,
          projectRoot: this.workspaceRootPath,
          entryFile: this.activeFilePath || path,
          cacheRoot,
          generateSourceMap: true
        },
        filePath: path,
        sourceCode: originalContent
      });
      
      if (this.lspSyncGenerations.get(key) !== gen) {
        return null;
      }
      
      this.preparedContentsCache.set(key, {
        content: originalContent,
        preparedText: res.preparedText,
        generatedPath: res.generatedPath
      });
      return {
        uri: filePathToUri(res.generatedPath),
        content: res.preparedText
      };
    } catch (err) {
      console.error("Failed to prepare render file:", err);
      if (this.lspSyncGenerations.get(key) !== gen) {
        return null;
      }
      return { uri: filePathToUri(path), content: originalContent };
    }
  }

  private getActiveLspUri(): string {
    if (!this.activeFilePath) return "";
    if (this.settingsController.value.preview.khmerRenderPreparation) {
      return filePathToUri(this.mapToCachePath(this.activeFilePath)!);
    }
    return filePathToUri(this.activeFilePath);
  }

  private async mapCacheLspPositionToOriginalEditorOffset(
    cacheRelPath: string,
    position: LspSourcePosition,
    cacheContent: string
  ): Promise<number | null> {
    if (!this.lspClient) return null;
    const lines = cacheContent.split(/\r?\n/);
    let utf16Offset = 0;
    for (let i = 0; i < Math.min(position.line, lines.length); i++) {
      utf16Offset += lines[i].length + 1;
    }
    if (position.line < lines.length) {
      utf16Offset += Math.min(position.character ?? 0, lines[position.line].length);
    }
    const subStr = cacheContent.substring(0, utf16Offset);
    const byteOffset = new TextEncoder().encode(subStr).length;

    const cacheRoot = this.getCacheRootPath();
    if (!cacheRoot) return null;

    try {
      const originalByteOffset = await invoke<number | null>("map_generated_to_source", {
        cacheRoot,
        relativePath: cacheRelPath,
        generatedOffset: byteOffset
      });
      if (originalByteOffset === null || originalByteOffset === undefined) return null;

      const originalContent = this.editorInstance.state.doc.toString();
      const originalBytes = new TextEncoder().encode(originalContent);
      const originalSubBytes = originalBytes.slice(0, originalByteOffset);
      const originalSubStr = new TextDecoder().decode(originalSubBytes);
      return Math.max(0, Math.min(originalSubStr.length, originalContent.length));
    } catch (e) {
      console.error("Error mapping offset:", e);
      return null;
    }
  }



  private async prepareRenderProjectIfNeeded(): Promise<void> {
    if (!this.workspaceRootPath || !this.settingsController.value.preview.khmerRenderPreparation) {
      return;
    }
    const cacheRoot = this.getCacheRootPath();
    if (!cacheRoot) return;
    
    const entryFile = this.activeFilePath || this.workspaceRootPath;
    
    try {
      await invoke("prepare_render_project", {
        options: {
          enableKhmerZws: true,
          projectRoot: this.workspaceRootPath,
          entryFile,
          cacheRoot,
          generateSourceMap: true
        }
      });
    } catch (e) {
      console.error("Failed to prepare render project:", e);
    }
  }

}

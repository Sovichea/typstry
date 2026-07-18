import { listen } from "@tauri-apps/api/event";
import { confirm, message, open, save } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { dirname, join } from "@tauri-apps/api/path";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, lineNumbers } from "@codemirror/view";
import { undo, redo, undoDepth } from "@codemirror/commands";
import { foldAll, foldEffect, foldedRanges, indentUnit, unfoldAll, unfoldEffect } from "@codemirror/language";
import { closeBrackets, closeCompletion, completionStatus } from "@codemirror/autocomplete";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { getEditorExtensions, themeCompartment, getThemeExtension, applyUIThemeVariables, wrapCompartment, lineNumbersCompartment, activeLineCompartment, closeBracketsCompartment, indentationGuidesCompartment, tabSizeCompartment, completionCompartment, showZwsCompartment, showZeroWidthSpaces } from "./editor/extensions";
import { createTypstAutocomplete } from "./editor/autocomplete";
import { cursorRowColumn } from "./editor/verticalCursor";
import type { EditorFoldRange } from "./editor/folding";
import { looksLikeStalePrefixDiagnostic, setEditorDiagnosticsEffect } from "./editor/diagnostics";
import type { EditorDiagnostic, EditorDiagnosticSeverity } from "./editor/diagnostics";
import { WorkspaceExplorer } from "./components/explorer";
import { TinymistLspClient } from "./compiler/lsp";
import type { EditorTextEdit, LspDiagnostic, LspInverseSyncResult, LspLogEntry, LspSourcePosition, LspStatus, PreviewDocumentPosition } from "./compiler/lsp";
import type { AppSettings, DeveloperLogCategory } from "./settings";
import { SettingsController } from "./settingsController";
import { fileNameFromPath, filePathFromUri, filePathKey, filePathToUri, nativeFilePath, relativeFilePath, remapFilePath } from "./platform/paths";
import { isBinaryImagePath, isSupportedInAppPath, fileExtension } from "./platform/fileTypes";
import { WysiwymAdapter } from "./wysiwym/adapter";
import { PreviewFrame, type PreviewClickPoint, type PreviewInteractionStatus } from "./preview/previewFrame";
import { PreviewSyncController } from "./preview/previewSyncController";
import { tinymistDataPlanePositionText } from "./preview/tinymistDataPlane";
import { allowsStandalonePreview, previewLspMainPath, previewRefreshStyle, previewSessionIdentity, researchDocumentIdentity, sourceMapPreviewTaskId, staleSourceMapTaskIds, tinymistPreviewNearbySourceColumns, usesTemplateAwareStandaloneRoot, type PreviewTarget, type PreviewRefreshStyle } from "./preview/previewPolicy";
import { LogConsoleController, spellcheckConsoleGroupKey, type LogConsoleEntryInput } from "./diagnostics/logConsoleController";
import { EditorFontManager } from "./editor/fontManager";
import { TabStripController } from "./editor/tabStripController";
import { createAppIcon, updateMaximizeIcon } from "./ui/icons";
import { installModalFocusTrap } from "./ui/modalFocus";
import {
  TYPSASTRA_GREEN,
  TYPSASTRA_GREEN_RIPPLE_FILL,
  TYPSASTRA_GREEN_RIPPLE_SHADOW
} from "./ui/brandColors";
import { LayoutController } from "./layout/layoutController";
import {
  WorkspaceStateStore,
  normalizeWorkspaceMetadata,
  workspaceRestoreCandidates,
  type LegacyWorkspaceState,
  type WorkspaceMetadata
} from "./workspace/workspaceStateStore";
import { RecentProjectsController, recentProjectShortcutIndex } from "./workspace/recentProjectsController";
import { WorkspaceWatcher, type WorkspaceChange } from "./workspace/workspaceWatcher";
import { workspaceViewportState } from "./workspace/workspaceVisibility";
import { installWelcomeKeyboardNavigation } from "./workspace/welcomeNavigation";
import { PerformanceDiagnostics, type PerformanceMetric } from "./performance/diagnostics";
import { EditorToolbarController } from "./editor/toolbarController";
import { ContextMenuController } from "./components/contextMenuController";
import { ToolchainController, type ToolchainStatus } from "./toolchain/toolchainController";
import { DocumentOutlineController, type DocumentHeading } from "./outline/documentOutline";
import { parseTypographyBlock, typographyEdit, type DocumentFontFallback, type DocumentTypography } from "./editor/documentTypography";
import { SpellcheckController, type SpellingIssue } from "./editor/spellcheck";
import { InputLanguageService } from "./editor/languageScopes";
import type { ImportedTypsastraProject, TypsastraProjectPreflight } from "./projectArchive";
import { AppUpdateController } from "./appUpdateController";

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

type ProcessMemorySample = {
  pid: number;
  parentPid: number;
  name: string;
  workingSetBytes: number;
};

type MemoryDiagnosticTotals = {
  jsHeapBytes: number;
  relatedBytes: number;
  webviewBytes: number;
  tinymistBytes: number;
  backendBytes: number;
};

const DEFAULT_INPUT_WIDTH_PCT = 50;
const DEFAULT_PREVIEW_WIDTH_PCT = 100 - DEFAULT_INPUT_WIDTH_PCT;
const DEFAULT_EXPLORER_WIDTH_PX = 250;

class PreviewPreparationInterrupted extends Error {
  constructor() {
    super("Preview preparation was superseded by editor input.");
  }
}

function isPreviewOnlyWindow(): boolean {
  return new URLSearchParams(window.location.search).get("mode") === "preview";
}


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
  previewDisabled: boolean;
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
  "previewRootPath" | "previewMainPath" | "previewTaskId" | "previewSessionKey" | "previewImported" | "previewStandalone" | "previewDisabled"
>;

type ActivateEditorTabOptions = {
  preservePreviewSession?: PreviewSessionState;
  skipPreviewActivation?: boolean;
  focusEditor?: boolean;
};

type LoadFileOptions = {
  temporary?: boolean;
  preservePreviewSession?: PreviewSessionState;
  skipPreviewActivation?: boolean;
  focusEditor?: boolean;
};

function normalizeEditorText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function isScrollbarPointerEvent(element: HTMLElement, event: PointerEvent): boolean {
  const rect = element.getBoundingClientRect();
  const canScrollVertically = element.scrollHeight > element.clientHeight;
  const canScrollHorizontally = element.scrollWidth > element.clientWidth;
  const verticalScrollbarWidth = canScrollVertically
    ? Math.max(12, element.offsetWidth - element.clientWidth)
    : 0;
  const horizontalScrollbarHeight = canScrollHorizontally
    ? Math.max(12, element.offsetHeight - element.clientHeight)
    : 0;
  const inVerticalScrollbar = canScrollVertically && event.clientX >= rect.right - verticalScrollbarWidth;
  const inHorizontalScrollbar = canScrollHorizontally && event.clientY >= rect.bottom - horizontalScrollbarHeight;
  return inVerticalScrollbar || inHorizontalScrollbar;
}

function ensureEditorCaretRippleStyle(): void {
  if (document.getElementById("typsastra-editor-caret-ripple-style")) return;
  const style = document.createElement("style");
  style.id = "typsastra-editor-caret-ripple-style";
  style.textContent = `
    @keyframes typsastra-editor-caret-ripple {
      0% { opacity: 0; transform: scale(.55); box-shadow: 0 0 0 0 rgba(61,180,137,.38); }
      12% { opacity: 1; }
      100% { opacity: 0; transform: scale(3.1); box-shadow: 0 0 0 14px rgba(61,180,137,0); }
    }
  `;
  document.head.appendChild(style);
}

export class TypsastraWorkspaceController {
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
  private previewDisabled = false;
  private pinnedLspMainPath: string | null = null;
  private pinnedMainFilePath: string | null = null;
  private workspaceRootPath: string | null = null;
  private workspaceMetadata: WorkspaceMetadata | null = null;
  private workspaceLoading = false;
  private wordWrapDeferredForResize = false;
  private recommendedWorkspaceToolchain: { tinymistVersion: string; typstVersion: string } | null = null;
  private selectedWorkspaceToolchain: { tinymistVersion: string; typstVersion: string } | null = null;
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
  private diagnosticWaitStartedAt: number | null = null;
  private openTabs: EditorTab[] = [];
  private suppressFoldStatePersistence = false;
  private readonly openedDocumentUris = new Set<string>();
  private readonly preparedPreviewDocumentVersions = new Map<string, number>();
  private lastKhmerRenderPrepState: boolean | undefined = undefined;
  private lastPreviewRenderMode: PreviewRefreshStyle | undefined = undefined;
  private workspaceChangeQueue: Promise<void> = Promise.resolve();
  private projectImportQueue: Promise<void> = Promise.resolve();
  private saveInProgress: Promise<void> | null = null;
  private pdfPreviewGeneration = 0;
  private imageZoomIn: (() => void) | null = null;
  private imageZoomOut: (() => void) | null = null;
  private imageZoomToFit: (() => void) | null = null;
  private imageZoomPercent: (() => number) | null = null;
  private imageIsFit: (() => boolean) | null = null;
  private pdfSyncPreviewTaskKey: string | null = null;
  private pdfSyncRegisteredTaskId: string | null = null;
  private pdfSourceMapStartupKey: string | null = null;
  private pdfSourceMapStartup: Promise<{ socket: WebSocket; taskId: string } | null> | null = null;
  private pdfSyncSocket: WebSocket | null = null;
  private pdfSyncSocketUrl = "";
  private pdfForwardSyncGeneration = 0;
  private pendingPdfForwardSync: { generation: number; requestedAt: number } | null = null;
  private manualForwardSyncGeneration: number | null = null;
  private queuedManualForwardSync: { path: string; cursor: number } | null = null;
  private pdfPreviewSourceMapRootPath: string | null = null;
  private pdfPreviewSourceMapTaskId: string | null = null;
  private pdfPreviewGeneratedFiles = new Map<string, { generatedPath: string; preparedText: string }>();
  private pdfPreviewTimer: number | null = null;
  private pdfPreviewScheduleGeneration = 0;
  private pdfPreparationRevision = 0;
  private pdfPreviewRunning = false;
  private queuedPdfPreviewContents: string | null = null;
  private queuedPdfPreviewForced = false;
  private typographyScaleCheckTimer: number | null = null;
  private typographyScaleCheckGeneration = 0;
  private typographyScaleConfirmationOpen = false;
  private suppressTypographyScaleConfirmation = false;
  private acceptedTypographyScales = new Map<string, DocumentFontFallback[]>();
  private typographyFontUpdateInProgress = false;
  private deferredTypographyPreviewContents: string | null = null;
  private lastPdfBase64 = "";
  private pdfPreviewFailureAt: number | null = null;
  private memoryDiagnosticSequence = 0;
  private saveMemoryDiagnosticGeneration = 0;
  private previousMemoryDiagnostic: MemoryDiagnosticTotals | null = null;
  private editorScrollbarPointerActive = false;
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
    onToolchainChanged: status => {
      if (this.workspaceRootPath && status.tinymistVersion && status.typstVersion) {
        this.selectedWorkspaceToolchain = {
          tinymistVersion: status.tinymistVersion,
          typstVersion: status.typstVersion
        };
        this.saveWorkspaceState();
      }
      return this.handleToolchainChanged(status);
    }
  });

  private editorInstance!: EditorView;
  private isComposing = false;
  private readonly performanceSummaryCounts = new Map<PerformanceMetric["name"], number>();
  private readonly performanceDiagnostics = new PerformanceDiagnostics(metric => this.publishPerformanceMetric(metric));
  private readonly editorFontManager = new EditorFontManager(() => this.editorInstance);
  private readonly spellcheckController = new SpellcheckController(
    () => this.editorInstance,
    issues => this.updateSpellcheckLog(issues),
    metric => this.performanceDiagnostics.record(metric)
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
  // WYSIWYM is intentionally disabled for this release. Keep a detached
  // container so the future adapter code can remain compiled without putting
  // the WYSIWYM pane into the active editor layout.
  private wysiwymPane = document.getElementById("wysiwym-editor-pane") as HTMLElement | null;
  private wysiwymContainer = this.wysiwymPane?.querySelector<HTMLElement>(".wysiwym-container") ?? document.createElement("div");
  private readonly wysiwymAdapter = new WysiwymAdapter(this.wysiwymContainer);
  private previewPane = document.getElementById("preview-render-pane")!;
  private readonly previewFrame = new PreviewFrame(this.previewPane, point => {
    void this.handlePdfPreviewClick(point);
  }, status => {
    this.reportPreviewInteractionStatus(status);
  }, zoomPercent => {
    this.updatePreviewZoomLabel(zoomPercent);
  }, metric => {
    this.performanceDiagnostics.recordFirst(metric) ?? this.performanceDiagnostics.record(metric);
  });
  private readonly previewSyncController = new PreviewSyncController({
    getEditor: () => this.editorInstance,
    getClient: () => this.lspClient,
    getActiveFilePath: () => this.activeFilePath,
    getPreviewRootPath: () => this.previewRootPath,
    getPreviewTaskId: () => this.previewTaskId,
    isReady: () => this.lspReady,
    // TODO: Re-enable in prerelease v0.9.0 after improving performance and timeout reliability
    // isEnabled: () => this.settingsController.value.preview.cursorSync,
    isEnabled: () => false,
    handleForwardPosition: (path, cursor) => this.handlePdfForwardSync(path, cursor),
    mapForwardPosition: async () => null
  });
  private readonly logConsoleController = new LogConsoleController(entry => this.navigateToLogEntry(entry));
  private readonly layoutController = new LayoutController(
    () => this.saveWorkspaceState(),
    () => this.logConsoleController.setVisible(false),
    message => this.appendDeveloperLog({ kind: "info", source: "preview layout", message }),
    () => this.beginHorizontalPaneResize(),
    () => this.endHorizontalPaneResize()
  );
  private readonly inputLanguageService = new InputLanguageService(
    () => this.spellcheckController.getProviders(),
    () => this.spellcheckController.getResolvedScopes(),
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
    renameWorkspacePath: (oldPath, newPath) => this.renameWorkspacePath(oldPath, newPath),
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
    addSpellingTerminology: (issue, scope) => {
      const entry = { term: issue.sourceText, exactCase: true };
      if (scope === "project") {
        if (!this.workspaceMetadata) return;
        const existing = this.workspaceMetadata.project.terminology;
        if (!existing.some(candidate => candidate.term === entry.term && candidate.exactCase === entry.exactCase)) {
          this.workspaceMetadata.project.terminology = [...existing, entry];
          this.settingsController.setProjectTerminology(this.workspaceMetadata.project.terminology);
          this.spellcheckController.setTerminology(
            this.settingsController.value.editor.globalTerminology,
            this.workspaceMetadata.project.terminology,
            this.settingsController.value.editor.languageTerminology,
            this.settingsController.value.editor.scopedIgnoredWords,
          );
          void this.saveWorkspaceState();
        }
        return;
      }
      this.settingsController.update(settings => {
        if (scope === "languageFamily" && issue.languageFamily) {
          if (!settings.editor.languageTerminology.some(candidate =>
            candidate.term === entry.term && candidate.languageFamily === issue.languageFamily)) {
            settings.editor.languageTerminology.push({ ...entry, languageFamily: issue.languageFamily });
          }
        } else if (!settings.editor.globalTerminology.some(candidate => candidate.term === entry.term)) {
          settings.editor.globalTerminology.push(entry);
        }
      });
    },
    setSpellingIgnored: (issue, ignored) => this.settingsController.update(settings => {
      if (ignored) {
        const entry = issue.languageFamily
          ? { term: issue.sourceText, scope: "languageFamily" as const, languageFamily: issue.languageFamily }
          : { term: issue.sourceText, scope: "global" as const };
        if (!settings.editor.scopedIgnoredWords.some(candidate => candidate.term === entry.term
          && candidate.scope === entry.scope && candidate.languageFamily === entry.languageFamily)) {
          settings.editor.scopedIgnoredWords.push(entry);
        }
      } else {
        settings.editor.ignoredWords = settings.editor.ignoredWords.filter(word => word !== issue.word);
        settings.editor.scopedIgnoredWords = settings.editor.scopedIgnoredWords.filter(entry =>
          entry.term !== issue.sourceText || (entry.languageFamily && entry.languageFamily !== issue.languageFamily));
      }
    }),
    isPinnedMainFile: path => this.isPinnedMainFile(path),
    setPinnedMainFile: path => this.setPinnedMainFile(path),
    getPinnedMainFile: () => this.pinnedMainFilePath
  });
  private readonly documentOutlineController = new DocumentOutlineController(
    document.getElementById("document-outline-tree")!,
    document.getElementById("document-outline-section")!,
    heading => void this.navigateToOutlineHeading(heading)
  );
  private readonly appUpdateController = new AppUpdateController(
    () => this.openTabs.some(tab => tab.isDirty)
  );
  private lspStatus = document.getElementById("lsp-status")!;
  private lspStatusDot = this.lspStatus.querySelector(".status-dot") as HTMLElement;
  private lspStatusText = this.lspStatus.querySelector(".status-text") as HTMLElement;

  public async bootstrap() {
    const isPreviewWindow = isPreviewOnlyWindow();
    if (isPreviewWindow) {
      await this.bootstrapPreviewWindow();
      return;
    }
    document.documentElement.classList.remove("preview-only-mode");
    document.body.classList.remove("preview-only-mode");

    await this.timeStartup("load settings", () => this.settingsController.load());
    for (const entry of this.settingsController.getTimings()) this.recordStartupTimingEntry(entry);
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
    this.appUpdateController.initialize();
    this.refreshEditorLayout("main window shown");
    this.recordStartupTiming("frontend startup", "frontend bootstrap until window shown", this.startupStart);
    this.performanceDiagnostics.recordFirst({
      name: "startup.usable-editor",
      milliseconds: performance.now() - this.startupStart
    });
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
    await this.drainPendingProjectImports();
    this.recordStartupTiming("frontend startup", "frontend bootstrap including LSP", this.startupStart);
  }

  private async bootstrapPreviewWindow() {
    document.documentElement.classList.add("preview-only-mode");
    document.body.classList.add("preview-only-mode");
    
    document.getElementById("preview-zoom-in-btn")?.addEventListener("click", () => {
      this.zoomIn();
    });
    document.getElementById("preview-zoom-out-btn")?.addEventListener("click", () => {
      this.zoomOut();
    });
    document.getElementById("preview-zoom-fit-btn")?.addEventListener("click", () => {
      this.zoomToFit();
    });

    const undockBtn = document.getElementById("undock-preview-btn");
    if (undockBtn) {
      undockBtn.title = "Dock Preview";
      undockBtn.addEventListener("click", () => {
        void getCurrentWindow().close();
      });
    }

    const previewWrapper = document.getElementById("preview-container-wrapper");
    if (previewWrapper) {
      previewWrapper.classList.remove("hidden");
      previewWrapper.style.display = "flex";
      previewWrapper.style.width = "100%";
      previewWrapper.style.height = "100%";
    }
    
    await getCurrentWindow().show();

    const { listen, emit } = await import("@tauri-apps/api/event");
    
    listen<string>("pdf-update", (event) => {
      const base64Data = event.payload;
      const rootPath = this.pdfPreviewSourceMapRootPath ?? this.previewRootPath ?? "preview";
      void this.previewFrame?.loadPdfData(base64Data, rootPath);
    });

    listen<{ page_no: number; x: number; y: number }>("pdf-forward-sync", (event) => {
      const pos = event.payload;
      void this.previewFrame?.revealDocumentPosition(pos);
    });

    emit("preview-window-ready");
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
    const loading = document.getElementById("workspace-loading");
    const viewport = workspaceViewportState(this.activeFilePath, this.workspaceRootPath, this.workspaceLoading);
    loading?.classList.toggle("hidden", !viewport.showLoading);

    if (viewport.showWelcome) {
      welcomeScreen?.classList.remove("hidden");
    } else {
      welcomeScreen?.classList.add("hidden");
    }

    if (viewport.showEditor) {
      inputWrapper?.classList.remove("hidden");
      previewWrapper?.classList.remove("hidden");
      resizer?.classList.remove("hidden");
      this.layoutController.dockPreview();
    } else {
      inputWrapper?.classList.add("hidden");
      previewWrapper?.classList.add("hidden");
      resizer?.classList.add("hidden");
    }

    if (viewport.showWorkspaceChrome) {
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
    void this.saveWorkspaceState();
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
    this.editorFontManager.configure(editor.codeFont, editor.unicodeFont, editor.unicodeFonts);
    this.spellcheckController.setEnabledProviders(editor.languageProviders);
    this.spellcheckController.setEmbeddedProviders(editor.embeddedSpellcheckLanguages);
    this.spellcheckController.setEnabled(editor.spellcheck);
    this.spellcheckController.setUserDictionary(editor.userDictionary);
    this.spellcheckController.setIgnoredWords(editor.ignoredWords);
    this.spellcheckController.setTerminology(
      editor.globalTerminology,
      this.workspaceMetadata?.project.terminology ?? [],
      editor.languageTerminology,
      editor.scopedIgnoredWords,
    );
    this.inputLanguageService.configure(
      editor.completionLanguageSource,
      editor.manualCompletionLanguage,
    );

    void applyUIThemeVariables(appearance.theme).then(() => this.previewFrame.syncTheme());

    const khmerPrepChanged = this.lastKhmerRenderPrepState !== undefined && this.lastKhmerRenderPrepState !== preview.khmerRenderPreparation;
    this.lastKhmerRenderPrepState = preview.khmerRenderPreparation;
    const previewRenderModeChanged = this.lastPreviewRenderMode !== undefined && this.lastPreviewRenderMode !== preview.renderMode;
    this.lastPreviewRenderMode = preview.renderMode;
    if (previewRenderModeChanged && preview.renderMode !== "on-type") {
      if (this.pdfPreviewTimer) {
        window.clearTimeout(this.pdfPreviewTimer);
        this.pdfPreviewTimer = null;
      }
      this.queuedPdfPreviewContents = null;
      this.queuedPdfPreviewForced = false;
    }

    const khmerPrepStatus = document.getElementById("khmer-prep-status");
    if (khmerPrepStatus) {
      if (preview.khmerRenderPreparation) {
        khmerPrepStatus.classList.remove("hidden");
      } else {
        khmerPrepStatus.classList.add("hidden");
      }
    }

    if (khmerPrepChanged && preview.renderMode === "on-type") {
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
              () => this.spellcheckController.getProviders(),
              position => this.inputLanguageService.completionProvider(position),
              () => this.inputLanguageService.currentGeneration(),
              milliseconds => this.performanceDiagnostics.record({ name: "language.completion", milliseconds }),
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
        () => this.spellcheckController.getProviders(),
        position => this.inputLanguageService.completionProvider(position),
        () => this.inputLanguageService.currentGeneration(),
        milliseconds => this.performanceDiagnostics.record({ name: "language.completion", milliseconds }),
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
            const wasComposing = this.isComposing;
            this.isComposing = update.view.composing;

            if (update.docChanged) {
              const currentText = update.state.doc.toString();
              this.previewSyncController.clearForward();
              this.editorFontManager.updateDocument(currentText);
              if (!update.view.composing) {
                this.handleContentMutation(currentText);
                this.spellcheckController.documentChanged(update);
              }
            } else if (wasComposing && !update.view.composing) {
              const currentText = update.state.doc.toString();
              this.handleContentMutation(currentText);
              this.spellcheckController.documentChanged(update);
            }
            if (update.selectionSet) {
              this.spellcheckController.selectionChanged(update.docChanged);
              this.syncSelectedSpellingLocation();
              this.documentOutlineController.setCursorPosition(update.state.selection.main.head, this.activeFilePath);
            } else if (update.docChanged) {
              this.logConsoleController.setActiveSpellcheckLocation(null);
            }
            if (update.selectionSet || update.docChanged) {
              this.updateCursorPositionStatus();
            }
            if (update.viewportChanged) {
              const topVisiblePosition = update.view.lineBlockAtHeight(update.view.scrollDOM.scrollTop).from;
              this.documentOutlineController.setCursorPosition(topVisiblePosition, this.activeFilePath);
            }
            if (!this.suppressFoldStatePersistence && update.transactions.some(transaction =>
              transaction.effects.some(effect => effect.is(foldEffect) || effect.is(unfoldEffect))
            )) {
              const tab = this.getActiveTab();
              if (tab) {
                tab.foldRanges = this.collectCurrentFoldRanges();
                void this.saveWorkspaceState();
              }
            }
            if (!update.docChanged && this.shouldForwardSyncSelectionUpdate(update)) {
              this.previewSyncController.schedule(this.forwardSyncDebounceMs);
            }
          })
        ]
      }),
      parent: this.codeRenderPane
    });
    // The editor remains mouse- and command-focusable, but ordinary Tab
    // navigation between application controls must never land in source text.
    this.editorInstance.contentDOM.tabIndex = -1;
    this.editorInstance.dom.addEventListener("pointerup", event => {
      if (!(event instanceof PointerEvent) || event.button !== 0) return;
      if (this.editorScrollbarPointerActive) {
        this.editorScrollbarPointerActive = false;
        this.previewSyncController.suppressForwardFor(250);
        return;
      }
      window.setTimeout(() => {
        const cursor = this.editorInstance.state.selection.main.head;
        void this.previewSyncController.renderAtCursor(cursor);
      }, 0);
    }, true);
    this.editorInstance.scrollDOM.addEventListener("pointerdown", event => {
      if (!(event instanceof PointerEvent) || event.button !== 0) return;
      if (!isScrollbarPointerEvent(this.editorInstance.scrollDOM, event)) return;
      this.editorScrollbarPointerActive = true;
      this.previewSyncController.suppressForwardFor(1000);
    }, true);
    window.addEventListener("pointerup", () => {
      if (!this.editorScrollbarPointerActive) return;
      window.setTimeout(() => {
        this.editorScrollbarPointerActive = false;
      }, 0);
    }, true);
    this.editorInstance.scrollDOM.addEventListener("scroll", () => {
      this.previewSyncController.suppressForwardFor(500);
    }, { passive: true });
    this.editorFontManager.updateDocument(initialDocument);
    this.updateCursorPositionStatus();
  }

  private updateCursorPositionStatus(): void {
    const status = document.getElementById("cursor-position-status");
    const label = status?.querySelector<HTMLElement>(".status-label");
    if (!status || !label || !this.editorInstance) return;
    const { row, column } = cursorRowColumn(
      this.editorInstance.state.doc,
      this.editorInstance.state.selection.main.head,
    );
    label.textContent = `Ln ${row}, Col ${column}`;
    status.setAttribute("aria-label", `Cursor at row ${row}, column ${column}`);
  }

  private refreshEditorLayout(reason: string): void {
    const editor = this.editorInstance;
    if (!editor) return;
    const refresh = () => {
      if (this.editorInstance !== editor) return;
      editor.requestMeasure();
      this.appendDeveloperLog({
        kind: "log",
        source: "editor layout",
        message: `Requested CodeMirror layout refresh after ${reason}.`
      });
    };
    requestAnimationFrame(() => requestAnimationFrame(refresh));
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
      (path: string, options?: { temporary?: boolean; focusEditor?: boolean }) => {
        void this.loadFile(path, options);
      },
      (path: string) => this.isPinnedMainFile(path)
    );
  }

  private sortPinnedMainTabFirst() {
    if (!this.pinnedMainFilePath) return;
    const index = this.openTabs.findIndex(tab => filePathKey(tab.path) === filePathKey(this.pinnedMainFilePath!));
    if (index > 0) {
      const [pinnedTab] = this.openTabs.splice(index, 1);
      pinnedTab.temporary = false; // Pinned is permanent
      this.openTabs.unshift(pinnedTab);
    }
  }

  private renderEditorTabs() {
    this.sortPinnedMainTabFirst();
    this.editorTabBar.innerHTML = "";

    for (const tab of this.openTabs) {
      const isPinnedMain = this.pinnedMainFilePath && filePathKey(tab.path) === filePathKey(this.pinnedMainFilePath);
      const tabButton = document.createElement("button");
      tabButton.className = `editor-tab${tab.path === this.activeFilePath ? " active" : ""}${tab.isDirty ? " dirty" : ""}${tab.temporary ? " temporary" : ""}${isPinnedMain ? " pinned-main-tab" : ""}`;
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

      if (!isPinnedMain) {
        const closeButton = document.createElement("span");
        closeButton.className = "editor-tab-close";
        closeButton.appendChild(createAppIcon("x", { size: 13 }));
        closeButton.title = "Close";
        closeButton.setAttribute("aria-label", `Close ${fileNameFromPath(tab.path)}`);
        tabButton.appendChild(closeButton);

        closeButton.addEventListener("click", (event) => {
          event.stopPropagation();
          void this.closeEditorTab(tab.path);
        });
      }

      tabButton.addEventListener("click", () => {
        void this.activateEditorTab(tab.path);
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
    const activeKey = filePathKey(this.activeFilePath);
    return this.openTabs.find((tab) => filePathKey(tab.path) === activeKey) ?? null;
  }

  private persistActiveTabState() {
    const tab = this.getActiveTab();
    if (!tab || !this.editorInstance) return;
    if (!isSupportedInAppPath(tab.path) || isBinaryImagePath(tab.path) || fileExtension(tab.path) === "pdf") return;

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
    this.suppressFoldStatePersistence = true;
    try {
      if (tab.foldRanges === null) {
        this.applyFoldRanges([]);
        foldAll(this.editorInstance);
        tab.foldRanges = this.collectCurrentFoldRanges();
      } else {
        const ranges = this.normalizeFoldRanges(tab.foldRanges, this.editorInstance.state.doc.length);
        tab.foldRanges = ranges;
        this.applyFoldRanges(ranges);
      }
    } finally {
      this.suppressFoldStatePersistence = false;
    }
  }

  private activateSpellcheckDocument(path: string | null): void {
    const inherited = Boolean(path && this.pinnedMainFilePath
      && filePathKey(path) !== filePathKey(this.pinnedMainFilePath));
    this.spellcheckController.setRootLanguageContext(inherited ? "inherited" : "main");
    this.spellcheckController.activateDocument(path ? filePathKey(path) : "");
  }

  private foldCurrentFile(): void {
    if (!this.getActiveTab() || !isSupportedInAppPath(this.activeFilePath ?? "") || isBinaryImagePath(this.activeFilePath ?? "") || fileExtension(this.activeFilePath ?? "") === "pdf") return;
    foldAll(this.editorInstance);
    this.editorInstance.focus();
  }

  private unfoldCurrentFile(): void {
    if (!this.getActiveTab() || !isSupportedInAppPath(this.activeFilePath ?? "") || isBinaryImagePath(this.activeFilePath ?? "") || fileExtension(this.activeFilePath ?? "") === "pdf") return;
    unfoldAll(this.editorInstance);
    this.editorInstance.focus();
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

  private async renameWorkspacePath(oldPath: string, newPath: string): Promise<void> {
    const workspaceRoot = this.workspaceRootPath;
    if (workspaceRoot) this.workspaceWatcher.stop();

    try {
      await invoke("rename_workspace_file", { oldPath, newPath });

      const renamedTabs: Array<{ oldPath: string; tab: EditorTab }> = [];
      for (const tab of this.openTabs) {
        const renamedPath = remapFilePath(tab.path, oldPath, newPath);
        if (renamedPath === tab.path) continue;

        renamedTabs.push({ oldPath: tab.path, tab });
        const acceptedScale = this.acceptedTypographyScales.get(filePathKey(tab.path));
        this.acceptedTypographyScales.delete(filePathKey(tab.path));
        if (acceptedScale !== undefined) {
          this.acceptedTypographyScales.set(filePathKey(renamedPath), acceptedScale);
        }
        tab.path = renamedPath;
      }

      this.activeFilePath = this.activeFilePath
        ? remapFilePath(this.activeFilePath, oldPath, newPath)
        : null;
      this.pinnedMainFilePath = this.pinnedMainFilePath
        ? remapFilePath(this.pinnedMainFilePath, oldPath, newPath)
        : null;
      this.pendingLspSyncPath = this.pendingLspSyncPath
        ? remapFilePath(this.pendingLspSyncPath, oldPath, newPath)
        : null;

      // Preview roots and task identities include the source path. Keeping any
      // of them after a rename lets stale and current sessions alternate.
      for (const tab of this.openTabs) {
        tab.previewRootPath = null;
        tab.previewMainPath = null;
        tab.previewTaskId = null;
        tab.previewSessionKey = null;
        tab.previewImported = false;
        tab.previewStandalone = true;
        tab.previewDisabled = false;
      }
      this.previewRootPath = null;
      this.previewMainPath = null;
      this.previewTaskId = null;
      this.previewSessionKey = null;
      this.previewImported = false;
      this.previewStandalone = true;
      this.previewDisabled = false;
      this.pinnedLspMainPath = null;
      this.pdfPreviewGeneratedFiles.clear();
      this.pdfPreparationRevision += 1;
      this.pdfPreviewScheduleGeneration += 1;
      if (this.pdfPreviewTimer !== null) {
        window.clearTimeout(this.pdfPreviewTimer);
        this.pdfPreviewTimer = null;
      }

      if (this.activeFilePath) {
        this.explorer.setActiveFile(this.activeFilePath);
        this.activateSpellcheckDocument(this.activeFilePath);
      }
      this.sortPinnedMainTabFirst();
      this.renderEditorTabs();
      await this.saveWorkspaceState();

      if (this.lspReady && this.lspClient) {
        try {
          for (const renamed of renamedTabs) {
            const oldUri = filePathToUri(renamed.oldPath);
            if (!this.openedDocumentUris.delete(oldUri)) continue;
            await this.lspClient.closeTextDocument(oldUri).catch(() => {});
            const newUri = filePathToUri(renamed.tab.path);
            await this.lspClient.openTextDocument(newUri, renamed.tab.content, renamed.tab.version);
            this.openedDocumentUris.add(newUri);
          }
          await this.lspClient.notifyWorkspaceFilesChanged([
            { uri: filePathToUri(oldPath), type: 3 },
            { uri: filePathToUri(newPath), type: 1 }
          ]);
        } catch (error) {
          this.appendDeveloperLog({
            kind: "warning",
            source: "workspace",
            message: `The file was renamed, but Tinymist's document state could not be transferred: ${String(error)}`
          });
        }
      }

      await this.prepareRenderProjectIfNeeded();
      await this.refreshActivePreviewRoot(true);
    } finally {
      if (workspaceRoot && this.workspaceRootPath === workspaceRoot) {
        await this.workspaceWatcher.start(workspaceRoot);
      }
    }
  }

  private async closeEditorTab(path: string, skipDirtyCheck = false) {
    if (this.pinnedMainFilePath && filePathKey(path) === filePathKey(this.pinnedMainFilePath)) {
      return;
    }
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
    this.acceptedTypographyScales.delete(filePathKey(path));
    await this.closeDocumentIfOpened(path);

    if (wasActive) {
      const nextTab = this.openTabs[Math.min(tabIndex, this.openTabs.length - 1)] ?? null;
      this.activeFilePath = null;
      this.previewRootPath = null;
      this.previewMainPath = null;
      this.previewTaskId = null;
      this.previewSessionKey = null;
      this.previewImported = false;
      this.previewStandalone = true;
      this.previewDisabled = false;
      this.clearDiagnostics();
      this.clearPendingLspSync();
      this.previewSyncController.clearForward();

      if (nextTab) {
        await this.activateEditorTab(nextTab.path, false);
      } else {
        this.explorer.setActiveFile(null);
        this.activateSpellcheckDocument(null);
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
    this.explorer.setActiveFile(path);
    if (this.workspaceRootPath) {
      await this.explorer.revealPath(path);
    }
    const tab = this.openTabs.find((candidate) => filePathKey(candidate.path) === filePathKey(path));
    const sameActivePath = this.activeFilePath !== null && filePathKey(this.activeFilePath) === filePathKey(path);
    const activeEditorMatchesTab = tab !== undefined && (
      !isSupportedInAppPath(tab.path) ||
      isBinaryImagePath(tab.path) ||
      fileExtension(tab.path) === "pdf" ||
      this.editorInstance.state.doc.toString() === tab.content
    );
    if (sameActivePath && tab && activeEditorMatchesTab) {
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
      if (options.focusEditor !== false) this.editorInstance.focus();
      this.saveWorkspaceState();
      return;
    }

    if (persistCurrent && !sameActivePath) {
      this.persistActiveTabState();
    }
    if (!sameActivePath) this.cancelManualForwardSync();

    if (!tab) {
      if (sameActivePath) {
        this.activeFilePath = null;
      }
      this.updateManualForwardSyncAction();
      return;
    }

    path = tab.path;
    this.acceptedTypographyScales.set(
      filePathKey(path),
      parseTypographyBlock(tab.content)?.fallbacks.map(fallback => ({ ...fallback })) ?? []
    );
    this.activateSpellcheckDocument(path);

    this.currentVersion = tab.version;
    this.latestDocumentVersion = tab.latestVersion;
    this.previewSyncController.reset();
    this.clearDiagnostics();

    this.isLoadingFile = true;
    try {
      const codeRenderPane = document.getElementById("code-render-pane");
      const imageViewerPane = document.getElementById("image-viewer-pane");
      const imageViewerImg = document.getElementById("image-viewer-img") as HTMLImageElement;

      const unsupportedFile = !isSupportedInAppPath(path);
      const isPdf = fileExtension(path) === "pdf";
      if (unsupportedFile || isBinaryImagePath(path) || isPdf) {
        codeRenderPane?.classList.add("hidden");
        imageViewerPane?.classList.remove("hidden");
        if (imageViewerImg) imageViewerImg.style.display = "none"; // Hide image element in editor
        
        this.renderNonTextEditorPlaceholder(path, unsupportedFile);
        document.getElementById("wysiwym-editor-pane")?.classList.add("hidden");

        this.imageZoomIn = null;
        this.imageZoomOut = null;
        this.imageZoomToFit = null;
        this.imageZoomPercent = null;
        this.imageIsFit = null;

        this.activateSpellcheckDocument(null);
        this.documentOutlineController.clear();
        if (!options.skipPreviewActivation) {
          this.updatePreviewActionsToolbar(path);
          if (isBinaryImagePath(path)) {
            this.renderInteractiveImageViewer(tab.content);
          } else if (isPdf) {
            void this.previewFrame.loadPdfData(tab.content, path);
          } else {
            this.previewFrame.setMessage(
              `<div class="preview-disabled-placeholder">` +
              `<div class="preview-disabled-title">Preview Unavailable</div>` +
              `<div class="preview-disabled-msg">Open this file with its system application to view it.</div>` +
              `</div>`
            );
          }
        }
        this.editorToolbarController.setDisabled(true);
        this.activeFilePath = path;
        this.isLoadingFile = false;
        this.updateManualForwardSyncAction();
        this.updateWorkspaceViewportVisibility();
        this.renderEditorTabs();
        this.saveWorkspaceState();
        return;
      } else {
        this.imageZoomIn = null;
        this.imageZoomOut = null;
        this.imageZoomToFit = null;
        this.imageZoomPercent = null;
        this.imageIsFit = null;

        this.updatePreviewActionsToolbar(path);
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
        },
        // A tab load is navigation, not an edit. Recording full-document
        // replacements in the shared history retains every visited document
        // and makes undo cross file boundaries.
        annotations: Transaction.addToHistory.of(false)
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
    if (path.toLowerCase().endsWith(".typ")) this.diagnosticWaitStartedAt = performance.now();
    let previewPresentationReused = false;
    let previewTarget: PreviewTarget | null = null;
    if (options.skipPreviewActivation) {
      // Restore editor/tab state first. Preview and LSP setup will run when the
      // toolchain reports readiness, avoiding startup-time restore failures.
    } else if (options.preservePreviewSession) {
      this.applyPreviewSessionToTab(tab, options.preservePreviewSession);
      if (options.preservePreviewSession.previewSessionKey) {
        previewPresentationReused = this.previewFrame.activateSession(options.preservePreviewSession.previewSessionKey);
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
            previewPresentationReused = this.previewFrame.activateSession(existingMainSession.previewSessionKey);
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


    if (!options.skipPreviewActivation && this.lspReady && this.lspClient) {
      const lspRes = await this.getLspUriAndContent(path, tab.content);
      if (lspRes) {
        const { uri: lspUri, content: lspContent } = lspRes;
        await this.openDocumentIfNeeded(lspUri, lspContent, this.currentVersion);
      }
      const lspMainPath = previewTarget
        ? previewLspMainPath(previewTarget)
        : (this.previewStandalone ? this.previewRootPath : (this.previewMainPath ?? this.previewRootPath));
      const pinChanged = await this.updatePinnedMain(lspMainPath);
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
        if (!previewPresentationReused) void this.renderPdfPreview(tab.content);
      } else {
        this.previewFrame.setMessage(`<div style="padding: 20px; color: #5f6368; font-family: var(--font-family-sans);">No preview root found for this library/template file. Diagnostics are still active.</div>`);
      }
    } else if (!options.skipPreviewActivation) {
      if (!options.preservePreviewSession && this.previewRootPath && !this.previewDisabled) {
        void this.renderPdfPreview(tab.content);
      }
    }

    if (this.activeMode === "WYSIWYM") {
      this.mapMarkupToWysiwym(tab.content);
    }

    this.updateWorkspaceViewportVisibility();
    this.refreshEditorLayout("tab activation");
    this.updateManualForwardSyncAction();
    if (options.focusEditor !== false) this.editorInstance.focus();
    this.saveWorkspaceState();
  }

  private async initLsp(shouldConnect = true) {
    if (!this.lspClient) {
      this.lspClient = new TinymistLspClient(
        () => {
          if (!this.workspaceRootPath) return null;
          return this.workspaceRootPath;
        },
        () => {},
        (status) => this.setLspStatus(status),
        (uri, position) => this.handleInverseSync(uri, position),
        (uri, diagnostics, version) => this.handleLspDiagnostics(uri, diagnostics, version),
        (entry) => this.appendLspLog(entry),
        (items) => this.documentOutlineController.updatePreviewPositions(items),
        (context) => this.handlePreviewStartupFailure(context)
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
      this.pdfSyncPreviewTaskKey = null;
      this.pdfSyncRegisteredTaskId = null;
      this.pdfSourceMapStartup = null;
      this.pdfSourceMapStartupKey = null;
      this.pdfSyncSocket?.close();
      this.pdfSyncSocket = null;
      this.pdfSyncSocketUrl = "";
    } catch (e) {
      this.lspReady = false;
      console.warn("Tinymist LSP instance offline.", e);
    }
  }

  private handlePreviewStartupFailure(context: {
    path: string;
    taskId: string;
    refreshStyle: "on-type" | "on-save";
    partialRendering: boolean;
    message: string;
  }): void {
    const affectsSourceMapSession = !this.pdfSyncRegisteredTaskId
      || context.taskId === this.pdfSyncRegisteredTaskId;
    if (affectsSourceMapSession) {
      this.pdfSyncPreviewTaskKey = null;
      this.pdfSyncRegisteredTaskId = null;
      this.pdfSyncSocket?.close();
      this.pdfSyncSocket = null;
      this.pdfSyncSocketUrl = "";
    }
    this.appendDeveloperLog({
      kind: "error",
      source: "preview startup",
      message: [
        `Tinymist preview startup failed: ${context.message}`,
        `root=${context.path}`,
        `task=${context.taskId}`,
        `mode=${context.refreshStyle}`,
        `partialRendering=${context.partialRendering}`,
        `active=${this.activeFilePath ?? "n/a"}`,
        `previewRoot=${this.previewRootPath ?? "n/a"}`,
        `previewMain=${this.previewMainPath ?? "n/a"}`
      ].join("; ")
    });
  }

  private async handleToolchainChanged(status: ToolchainStatus) {
    this.toolchainController.setStatus(status);
    this.lspReady = false;
    this.pdfSyncPreviewTaskKey = null;
    this.pdfSyncRegisteredTaskId = null;
    this.pdfSourceMapStartup = null;
    this.pdfSourceMapStartupKey = null;
    this.pdfSyncSocket?.close();
    this.pdfSyncSocket = null;
    this.pdfSyncSocketUrl = "";
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
    const existingTab = this.openTabs.find((tab) => filePathKey(tab.path) === filePathKey(path));
    if (existingTab) {
      if (!options.temporary) {
        void this.promoteToPermanent(existingTab);
      }
      await this.activateEditorTab(existingTab.path, true, {
        preservePreviewSession: options.preservePreviewSession,
        skipPreviewActivation: options.skipPreviewActivation,
        focusEditor: options.focusEditor
      });
      return;
    }
    if (this.activeFilePath && filePathKey(this.activeFilePath) === filePathKey(path)) {
      this.activeFilePath = null;
    }

    try {
      const contents = !isSupportedInAppPath(path)
        ? ""
        : (isBinaryImagePath(path) || fileExtension(path) === "pdf")
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
        previewDisabled: false,
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
        preservePreviewSession: options.preservePreviewSession,
        skipPreviewActivation: options.skipPreviewActivation,
        focusEditor: options.focusEditor
      });
    } catch (e) {
      console.error("Failed to load file:", e);
      alert("Failed to load file: " + e);
    }
  }

  private async saveActiveFile() {
    if (this.saveInProgress) return await this.saveInProgress;
    const operation = this.performSaveActiveFile();
    this.saveInProgress = operation;
    try {
      await operation;
    } finally {
      if (this.saveInProgress === operation) this.saveInProgress = null;
    }
  }

  private deferWordWrapForResize(): void {
    const editor = this.editorInstance;
    if (!editor || !this.settingsController.value.editor.wordWrap || this.wordWrapDeferredForResize) return;
    this.wordWrapDeferredForResize = true;
    editor.dispatch({ effects: wrapCompartment.reconfigure([]) });
  }

  private beginHorizontalPaneResize(): void {
    this.previewFrame.suspendResizeLayout();
    this.deferWordWrapForResize();
  }

  private endHorizontalPaneResize(): void {
    this.restoreWordWrapAfterResize();
    this.previewFrame.resumeResizeLayout();
  }

  private restoreWordWrapAfterResize(): void {
    if (!this.wordWrapDeferredForResize) return;
    this.wordWrapDeferredForResize = false;
    const editor = this.editorInstance;
    if (!editor) return;
    editor.dispatch({
      effects: wrapCompartment.reconfigure(
        this.settingsController.value.editor.wordWrap ? EditorView.lineWrapping : []
      )
    });
    this.refreshEditorLayout("resize completed");
  }

  private async performSaveActiveFile(): Promise<void> {
    if (!this.activeFilePath || !isSupportedInAppPath(this.activeFilePath) || isBinaryImagePath(this.activeFilePath) || fileExtension(this.activeFilePath) === "pdf") {
      return;
    }

    try {
      const saveDiagnosticId = ++this.saveMemoryDiagnosticGeneration;
      await this.logMemoryDiagnostics(`save ${saveDiagnosticId}: before write`);
      if (this.activeMode === "CODE" && this.settingsController.value.editor.formatOnSave) {
        await this.formatActiveDocument({ silent: true });
        this.removeTrailingSpaces();
      }

      const content = this.activeMode === "WYSIWYM"
        ? this.mapWysiwymToMarkup()
        : this.editorInstance.state.doc.toString();

      await invoke("save_workspace_file", {
        path: this.activeFilePath,
        contents: content
      });
      await this.logMemoryDiagnostics(`save ${saveDiagnosticId}: after workspace write`);

      if (this.lspReady && this.lspClient) {
        await this.flushPendingLspSync();
        const lspRes = await this.getLspUriAndContent(this.activeFilePath, content);
        if (lspRes) {
          const { uri: lspUri, content: lspContent } = lspRes;
          await this.lspClient.notifyTextSave(lspUri, lspContent);
        }
      }
      await this.logMemoryDiagnostics(`save ${saveDiagnosticId}: after LSP save notification`);

      const activeTab = this.getActiveTab();
      const savedChangedRevision = activeTab
        ? content !== activeTab.savedContent
        : false;
      if (activeTab) {
        activeTab.content = content;
        activeTab.savedContent = content;
        activeTab.isDirty = false;
        this.externalConflictPaths.delete(filePathKey(activeTab.path));
        this.renderEditorTabs();
      }
      this.setLspStatus({ kind: "preview-ready", message: "File saved" });
      if (savedChangedRevision && this.settingsController.value.preview.renderMode === "on-save" && !this.previewDisabled) {
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
      try {
        await this.reloadWorkspaceFonts();
      } catch (restartError) {
        this.appendDeveloperLog({
          kind: "error",
          source: "typography",
          message: `Failed to restore Tinymist after typography error: ${String(restartError)}`
        });
      }
      this.appendLspLog({
        kind: "warning",
        source: "formatter",
        message: `Format failed: ${String(error)}`
      });
      if (!options.silent) this.setLspStatus({ kind: "error", message: `Format failed: ${String(error)}` });
      return false;
    }
  }

  private removeTrailingSpaces(): void {
    if (this.activeMode !== "CODE" || !this.editorInstance) return;
    const doc = this.editorInstance.state.doc;
    const changes: { from: number; to: number; insert: string }[] = [];
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const match = /[ \t]+$/u.exec(line.text);
      if (match) {
        changes.push({
          from: line.from + match.index,
          to: line.to,
          insert: ""
        });
      }
    }
    if (changes.length > 0) {
      this.editorInstance.dispatch({
        changes,
        userEvent: "input.format"
      });
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
    const typographyDocumentKey = filePathKey(this.activeFilePath);
    const previousAcceptedScale = this.acceptedTypographyScales.get(typographyDocumentKey) ?? [];
    this.acceptedTypographyScales.set(typographyDocumentKey, config.fallbacks.map(fallback => ({ ...fallback })));
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
        const fontsChanged = await this.updateWorkspaceTypographyFont(config);
        await this.refreshActivePreviewRoot(fontsChanged);
        editor.focus();
        return;
      }

      const activeText = this.editorInstance.state.doc.toString();
      const hasExistingBlock = activeText.includes("// typsastra:typography:start");
      const detectedTemplateFunc = findTemplateFunctionName(activeText);

      if (hasExistingBlock || detectedTemplateFunc) {
        const funcName = detectedTemplateFunc || "typsastra-typography";
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
          const fontsChanged = await this.updateWorkspaceTypographyFont(config);
          editor.focus();
          this.setLspStatus({ kind: "preview-ready", message: "Typography applied to template" });
          await this.refreshActivePreviewRoot(fontsChanged);
          return;
        }
      }

      const mainPath = this.previewStandalone ? this.activeFilePath : (this.previewMainPath ?? this.activeFilePath);
      const mainText = await this.workspaceText(mainPath!);
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
        const templatePath = await join(mainDirectory, "typsastra-template.typ");
        const exists = await invoke<boolean>("workspace_path_exists", { path: templatePath });
        let templateText = exists ? await this.workspaceText(templatePath) : newTypographyTemplate(config);
        if (exists) {
          const edit = templateTypographyEdit(templateText, "typsastra-typography", config);
          templateText = edit ? this.applyEdit(templateText, edit) : newTypographyTemplate(config);
        }
        await this.writeWorkspaceText(templatePath, templateText);

        const applicationEdit = ensureTypographyTemplateApplication(mainText);
        if (applicationEdit.insert || applicationEdit.from !== applicationEdit.to) {
          await this.writeWorkspaceText(mainPath, this.applyEdit(mainText, applicationEdit));
        }
      }

      this.setLspStatus({ kind: "preview-ready", message: "Typography applied to template" });
      const fontsChanged = await this.updateWorkspaceTypographyFont(config);
      await this.refreshActivePreviewRoot(fontsChanged);
      this.editorInstance.focus();
    } catch (error) {
      this.acceptedTypographyScales.set(typographyDocumentKey, previousAcceptedScale);
      this.appendLspLog({
        kind: "error",
        source: "typography",
        message: `Failed to apply template typography: ${String(error)}`
      });
      await message(String(error), { title: "Unable to apply typography", kind: "error" });
    }
  }

  private async prepareWorkspaceTypographyFont(config: DocumentTypography): Promise<boolean> {
    if (!this.workspaceRootPath) return false;
    const scaled = config.fallbacks.filter(fallback => Math.abs(fallback.scale - 1) > 0.0001);
    const updateRequired = await invoke<boolean>("scaled_workspace_font_set_update_required", {
      workspaceRootPath: this.workspaceRootPath,
      fonts: scaled
    });
    if (!updateRequired) return false;
    this.typographyFontUpdateInProgress = true;
    let changed = await invoke<boolean>("clear_scaled_workspace_fonts", { workspaceRootPath: this.workspaceRootPath });
    if (scaled.length === 0) return changed;
    this.previewFrame.setLoading(`Scaling ${scaled.length} document fallback font${scaled.length === 1 ? "" : "s"}… This one-time setup may take a moment.`);
    for (const fallback of scaled) {
      const result = await invoke<{ changed: boolean }>("prepare_scaled_workspace_font", {
        workspaceRootPath: this.workspaceRootPath,
        family: fallback.family,
        scale: fallback.scale
      });
      changed ||= result.changed;
    }
    return changed;
  }

  private async updateWorkspaceTypographyFont(config: DocumentTypography): Promise<boolean> {
    let changed = false;
    try {
      changed = await this.prepareWorkspaceTypographyFont(config);
      if (changed) await this.reloadWorkspaceFonts();
    } finally {
      this.typographyFontUpdateInProgress = false;
    }
    const hadDeferredPreview = this.deferredTypographyPreviewContents !== null;
    this.deferredTypographyPreviewContents = null;
    return changed || hadDeferredPreview;
  }

  private async reloadWorkspaceFonts(): Promise<void> {
    if (!this.lspClient || !this.workspaceRootPath) return;
    this.setLspStatus({ kind: "starting", message: "Reloading workspace fonts..." });
    this.lspReady = false;
    this.openedDocumentUris.clear();
    await this.lspClient.restart();
    this.lspReady = true;
    this.pinnedLspMainPath = null;
    const lspMainPath = this.previewStandalone
      ? this.previewRootPath
      : (this.previewMainPath ?? this.previewRootPath);
    await this.updatePinnedMain(lspMainPath, true);
    if (this.activeFilePath) {
      await this.recheckActiveDocumentAfterPin(this.editorInstance.state.doc.toString());
    }
    this.pdfSyncPreviewTaskKey = null;
    this.pdfSyncRegisteredTaskId = null;
    this.pdfSourceMapStartup = null;
    this.pdfSourceMapStartupKey = null;
    this.pdfSyncSocket?.close();
    this.pdfSyncSocket = null;
    this.pdfSyncSocketUrl = "";
  }

  private applyPreviewTargetToTab(tab: EditorTab, target: PreviewTarget): void {
    const style = previewRefreshStyle(this.settingsController.value.preview.renderMode);
    const document = target.rootPath
      ? researchDocumentIdentity(this.workspaceRootPath ?? target.rootPath, target.mainPath, tab.path)
      : null;
    const identity = target.rootPath ? previewSessionIdentity(target.rootPath, style, document ?? undefined) : null;
    tab.previewRootPath = target.rootPath;
    tab.previewMainPath = target.mainPath;
    tab.previewTaskId = identity?.taskId ?? null;
    tab.previewSessionKey = identity?.key ?? null;
    tab.previewImported = target.imported;
    tab.previewStandalone = target.standalone;
    tab.previewDisabled = target.disabled;
    this.previewRootPath = tab.previewRootPath;
    this.previewMainPath = tab.previewMainPath;
    this.previewTaskId = tab.previewTaskId;
    this.previewSessionKey = tab.previewSessionKey;
    this.previewImported = tab.previewImported;
    this.previewStandalone = tab.previewStandalone;
    this.previewDisabled = tab.previewDisabled;
  }

  private capturePreviewSession(): PreviewSessionState {
    return {
      previewRootPath: this.previewRootPath,
      previewMainPath: this.previewMainPath,
      previewTaskId: this.previewTaskId,
      previewSessionKey: this.previewSessionKey,
      previewImported: this.previewImported,
      previewStandalone: this.previewStandalone,
      previewDisabled: this.previewDisabled
    };
  }

  private captureCurrentMainSessionForImportedTarget(target: PreviewTarget): PreviewSessionState | null {
    if (target.standalone) return null;
    if (!target.imported || !target.mainPath || !this.previewRootPath || !this.previewSessionKey) {
      return null;
    }
    const mainKey = filePathKey(target.mainPath);
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
    tab.previewDisabled = session.previewDisabled;
    this.previewRootPath = session.previewRootPath;
    this.previewMainPath = session.previewMainPath;
    this.previewTaskId = session.previewTaskId;
    this.previewSessionKey = session.previewSessionKey;
    this.previewImported = session.previewImported;
    this.previewStandalone = session.previewStandalone;
    this.previewDisabled = session.previewDisabled;
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
        previewRefreshStyle(this.settingsController.value.preview.renderMode),
        researchDocumentIdentity(this.workspaceRootPath, target.mainPath, activePath)
      );
      const previewPath = await join(
        this.workspaceRootPath,
        `.${fileNameFromPath(activePath)}.${identity.taskId}.typsastra-preview.typ`
      );
      const previewSource = templatePreviewSource(application, templateRootPath, chapterRootPath, activeContents);
      const existingSource = await invoke<string>("read_workspace_file", { path: previewPath }).catch(() => null);
      if (existingSource !== previewSource) {
        await invoke("save_workspace_file", { path: previewPath, contents: previewSource });
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

  private async closeDocumentIfOpened(path: string): Promise<void> {
    if (!this.lspClient) return;
    const uri = filePathToUri(path);
    if (!this.openedDocumentUris.delete(uri)) return;
    try {
      await this.lspClient.closeTextDocument(uri);
    } catch (error) {
      this.openedDocumentUris.add(uri);
      this.appendDeveloperLog({
        kind: "warning",
        source: "lsp",
        message: `Failed to close ${fileNameFromPath(path)} in Tinymist: ${String(error)}`
      });
    }
  }

  private async updatePinnedMain(path: string | null, force = false): Promise<boolean> {
    if (!this.lspReady || !this.lspClient) return false;
    const targetPath = path;
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

  private async renderPdfPreview(contents: string, force = false): Promise<void> {
    if (this.previewDisabled) {
      this.appendDeveloperLog({ kind: "info", source: "preview scheduler", message: "Render skipped: preview is disabled." });
      return;
    }
    if (this.typographyFontUpdateInProgress) {
      this.deferredTypographyPreviewContents = contents;
      this.appendDeveloperLog({
        kind: "info",
        source: "preview scheduler",
        message: `Render deferred while typography fonts are updating: sourceUtf16=${contents.length}; forced=${force}.`
      });
      return;
    }
    if (!this.activeFilePath || !this.lspReady || !this.lspClient) {
      this.appendDeveloperLog({
        kind: "info",
        source: "preview scheduler",
        message: `Render skipped: active=${this.activeFilePath ?? "none"}; lspReady=${this.lspReady}; client=${!!this.lspClient}.`
      });
      return;
    }
    if (force) {
      this.previewFrame.setLoading("Recompiling PDF preview...");
    }
    if (this.pdfPreviewRunning) {
      this.queuedPdfPreviewContents = contents;
      this.queuedPdfPreviewForced ||= force;
      this.appendDeveloperLog({
        kind: "info",
        source: "preview scheduler",
        message: `Render queued behind active generation ${this.pdfPreviewGeneration}: sourceUtf16=${contents.length}; forced=${this.queuedPdfPreviewForced}.`
      });
      return;
    }
    this.cancelManualForwardSync();
    this.pdfPreviewRunning = true;
    const compileStartedAt = performance.now();
    const generation = ++this.pdfPreviewGeneration;
    const preparationRevision = this.pdfPreparationRevision;
    await this.logMemoryDiagnostics(`render ${generation}: before preparation`);
    this.appendDeveloperLog({
      kind: "info",
      source: "preview scheduler",
      message: `Render generation ${generation} started: mode=${this.settingsController.value.preview.renderMode}; active=${this.activeFilePath}; sourceUtf16=${contents.length}.`
    });
    this.setLspStatus({ kind: "syncing", message: "Compiling PDF preview..." });
    if (!force && !this.previewFrame.currentUrl) {
      this.previewFrame.setLoading("Compiling PDF preview...");
    }
    try {
      await this.flushPendingLspSync();
      this.ensurePreviewPreparationCurrent(preparationRevision);
      this.appendDeveloperLog({ kind: "info", source: "preview scheduler", message: `Render generation ${generation}: LSP flush complete.` });
      const previewPath = await this.preparePdfPreviewExportPath(contents, preparationRevision);
      if (!previewPath) throw new Error("No PDF preview root is available.");
      this.ensurePreviewPreparationCurrent(preparationRevision);
      this.appendDeveloperLog({ kind: "info", source: "preview scheduler", message: `Render generation ${generation}: preview root prepared at ${previewPath}.` });
      if (this.settingsController.value.preview.renderMode === "on-type") {
        const preparedPaths = [...new Set([
          previewPath,
          ...[...this.pdfPreviewGeneratedFiles.values()].map(file => file.generatedPath)
        ].map(nativeFilePath))];
        await this.lspClient.notifyWorkspaceFilesChanged(
          preparedPaths.map(path => ({ uri: filePathToUri(path), type: 2 as const }))
        );
        this.ensurePreviewPreparationCurrent(preparationRevision);
        const syncedPreparedDocuments = await this.syncPreparedPreviewDocuments(previewPath);
        this.ensurePreviewPreparationCurrent(preparationRevision);
        this.appendDeveloperLog({
          kind: "info",
          source: "preview scheduler",
          message: `Render generation ${generation}: invalidated ${preparedPaths.length} prepared file(s) and synchronized ${syncedPreparedDocuments} in-memory document(s) in Tinymist.`
        });
      }
      const pdf = await this.lspClient.exportPdfToMemory(previewPath);
      this.ensurePreviewPreparationCurrent(preparationRevision);
      this.appendDeveloperLog({ kind: "info", source: "preview scheduler", message: `Render generation ${generation}: Tinymist PDF export complete.` });
      await this.logMemoryDiagnostics(
        `render ${generation}: after Tinymist export`,
        { exportBase64Chars: pdf.data?.length ?? 0 }
      );
      this.performanceDiagnostics.record({
        name: "preview.compile",
        milliseconds: performance.now() - compileStartedAt,
        detail: { sourceUtf16: contents.length }
      });
      if (
        this.queuedPdfPreviewContents !== null
        && (this.queuedPdfPreviewForced || this.queuedPdfPreviewContents !== contents)
      ) {
        this.appendDeveloperLog({
          kind: "info",
          source: "preview scheduler",
          message: `Render generation ${generation} discarded: a newer queued request exists (queuedUtf16=${this.queuedPdfPreviewContents.length}; forced=${this.queuedPdfPreviewForced}).`
        });
        return;
      }
      if (generation !== this.pdfPreviewGeneration) {
        this.appendDeveloperLog({
          kind: "info",
          source: "preview scheduler",
          message: `Render generation ${generation} discarded: current generation is ${this.pdfPreviewGeneration}.`
        });
        return;
      }
      this.setLspStatus({ kind: "preview-ready", message: "PDF Preview Ready" });
      const sourceMapTaskId = previewSessionIdentity(
        previewPath,
        previewRefreshStyle(this.settingsController.value.preview.renderMode)
      ).taskId;
      // Source-map tasks are reconciled lazily by ensurePdfSourceMapSocket.
      // Never let optional cursor-sync lifecycle work block PDF presentation.
      this.pdfPreviewSourceMapRootPath = previewPath;
      this.pdfPreviewSourceMapTaskId = sourceMapTaskId;
      this.lastPdfBase64 = pdf.data!;
      await this.previewFrame.loadPdfData(pdf.data!, previewPath);
      this.appendDeveloperLog({ kind: "info", source: "preview scheduler", message: `Render generation ${generation}: PDF presentation complete.` });
      await this.logMemoryDiagnostics(`render ${generation}: after PDF cleanup/presentation`);
      window.setTimeout(() => {
        void this.logMemoryDiagnostics(`render ${generation}: settled after page rendering`);
      }, 1000);
      if (this.pdfPreviewFailureAt !== null) {
        this.performanceDiagnostics.record({
          name: "preview.recovery",
          milliseconds: performance.now() - this.pdfPreviewFailureAt
        });
        this.pdfPreviewFailureAt = null;
      }
      const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
      if (typeof memory?.usedJSHeapSize === "number") {
        this.performanceDiagnostics.record({ name: "memory.heap", bytes: memory.usedJSHeapSize });
      }
      import("@tauri-apps/api/event").then(({ emit }) => {
        emit("pdf-update", pdf.data!);
      }).catch(err => console.error("Error emitting pdf-update", err));
    } catch (error) {
      if (this.typographyFontUpdateInProgress) {
        this.appendDeveloperLog({
          kind: "info",
          source: "preview scheduler",
          message: `Render generation ${generation} interrupted for typography font replacement.`
        });
        return;
      }
      if (
        error instanceof PreviewPreparationInterrupted
        || (
          this.settingsController.value.preview.renderMode === "on-type"
          && preparationRevision !== this.pdfPreparationRevision
        )
      ) {
        this.appendDeveloperLog({
          kind: "info",
          source: "preview scheduler",
          message: `Render generation ${generation} interrupted by editor input; waiting for the next debounce.`
        });
        return;
      }
      if (generation !== this.pdfPreviewGeneration) {
        this.appendDeveloperLog({
          kind: "warning",
          source: "preview scheduler",
          message: `Render generation ${generation} failed after becoming stale: ${String(error)}`
        });
        return;
      }
      console.error("PDF Preview compilation failed:", JSON.stringify(error, null, 2));
      this.previewFrame.setError(
        "Preview Render Failed",
        String(error)
      );
      this.setLspStatus({ kind: "preview-ready", message: "PDF compile failed" });
      this.pdfPreviewFailureAt ??= performance.now();
    } finally {
      this.pdfPreviewRunning = false;
      const queued = this.queuedPdfPreviewContents;
      const queuedForced = this.queuedPdfPreviewForced;
      this.queuedPdfPreviewContents = null;
      this.queuedPdfPreviewForced = false;
      this.appendDeveloperLog({
        kind: "info",
        source: "preview scheduler",
        message: `Render generation ${generation} released: queued=${queued !== null}; queuedChanged=${queued !== null && queued !== contents}; queuedForced=${queuedForced}.`
      });
      if (queued !== null && (queuedForced || queued !== contents)) {
        void this.renderPdfPreview(queued, queuedForced);
      }
      this.updateManualForwardSyncAction();
    }
  }

  private recompilePreviewManually(): void {
    if (!this.activeFilePath?.toLowerCase().endsWith(".typ")) return;
    if (this.pdfPreviewTimer) {
      window.clearTimeout(this.pdfPreviewTimer);
      this.pdfPreviewTimer = null;
    }
    const contents = this.editorInstance.state.doc.toString();
    this.appendDeveloperLog({
      kind: "info",
      source: "preview scheduler",
      message: `Manual preview recompile requested: active=${this.activeFilePath}; sourceUtf16=${contents.length}.`
    });
    void this.renderPdfPreview(contents, true);
  }

  private ensurePreviewPreparationCurrent(revision: number): void {
    if (
      this.settingsController.value.preview.renderMode === "on-type"
      && revision !== this.pdfPreparationRevision
    ) {
      throw new PreviewPreparationInterrupted();
    }
  }

  private async preparePdfPreviewExportPath(contents: string, preparationRevision = this.pdfPreparationRevision): Promise<string | null> {
    if (!this.activeFilePath) return null;
    const rootPath = this.previewStandalone ? (this.previewRootPath ?? this.activeFilePath) : (this.previewMainPath ?? this.previewRootPath ?? this.activeFilePath);
    if (!rootPath) return null;

    const shouldMirror = this.settingsController.value.preview.renderMode === "on-type";
    if (!shouldMirror || !this.workspaceRootPath) {
      this.pdfPreviewGeneratedFiles.clear();
      return rootPath;
    }

    const cacheRoot = this.getCacheRootPath();
    if (!cacheRoot) return rootPath;
    this.pdfPreviewGeneratedFiles.clear();
    const originalRootPath = this.mapToOriginalPath(rootPath);
    const originalActivePath = this.mapToOriginalPath(this.activeFilePath);
    const options = {
      enableKhmerZws: this.settingsController.value.preview.khmerRenderPreparation,
      projectRoot: this.workspaceRootPath,
      entryFile: originalRootPath,
      cacheRoot,
      generateSourceMap: true
    };
    const result = await invoke<{ generatedEntryFile: string }>("prepare_render_project", { options });
    this.ensurePreviewPreparationCurrent(preparationRevision);
    const tabsToOverlay = this.openTabs
      .filter(tab => tab.path.toLowerCase().endsWith(".typ"))
      .filter(tab => this.workspaceRootPath && relativeFilePath(this.workspaceRootPath, this.mapToOriginalPath(tab.path)) !== null);
    const overlaid = new Set<string>();
    for (const tab of tabsToOverlay) {
      const originalTabPath = this.mapToOriginalPath(tab.path);
      overlaid.add(filePathKey(originalTabPath));
      const sourceCode = filePathKey(originalTabPath) === filePathKey(originalActivePath)
        ? contents
        : tab.content;
      const generated = await invoke<{ generatedPath: string; preparedText: string }>("prepare_render_file", {
        options,
        filePath: originalTabPath,
        sourceCode
      });
      this.ensurePreviewPreparationCurrent(preparationRevision);
      this.pdfPreviewGeneratedFiles.set(filePathKey(originalTabPath), generated);
    }
    if (!overlaid.has(filePathKey(originalActivePath))) {
      const activeGenerated = await invoke<{ generatedPath: string; preparedText: string }>("prepare_render_file", {
        options,
        filePath: originalActivePath,
        sourceCode: contents
      });
      this.ensurePreviewPreparationCurrent(preparationRevision);
      this.pdfPreviewGeneratedFiles.set(filePathKey(originalActivePath), activeGenerated);
    }
    return result.generatedEntryFile;
  }

  private async syncPreparedPreviewDocuments(previewPath: string): Promise<number> {
    if (!this.lspClient) return 0;
    const documents = new Map<string, { path: string; text: string }>();
    for (const file of this.pdfPreviewGeneratedFiles.values()) {
      documents.set(filePathKey(file.generatedPath), {
        path: file.generatedPath,
        text: file.preparedText
      });
    }
    const previewKey = filePathKey(previewPath);
    if (!documents.has(previewKey)) {
      const text = await invoke<string>("read_workspace_file", { path: previewPath });
      documents.set(previewKey, { path: previewPath, text: normalizeEditorText(text) });
    }

    for (const document of documents.values()) {
      const uri = filePathToUri(nativeFilePath(document.path));
      const version = (this.preparedPreviewDocumentVersions.get(uri) ?? 0) + 1;
      this.preparedPreviewDocumentVersions.set(uri, version);
      if (this.openedDocumentUris.has(uri)) {
        await this.lspClient.notifyTextChange(uri, document.text, version);
      } else {
        await this.lspClient.openTextDocument(uri, document.text, version);
        this.openedDocumentUris.add(uri);
      }
    }
    return documents.size;
  }

  private schedulePdfPreview(contents: string) {
    if (this.previewDisabled) {
      this.appendDeveloperLog({ kind: "info", source: "preview scheduler", message: "On-type schedule skipped: preview is disabled." });
      return;
    }
    if (this.settingsController.value.preview.renderMode !== "on-type") {
      this.appendDeveloperLog({ kind: "info", source: "preview scheduler", message: `On-type schedule skipped: mode=${this.settingsController.value.preview.renderMode}.` });
      return;
    }
    if (this.pdfPreviewTimer) {
      window.clearTimeout(this.pdfPreviewTimer);
      this.appendDeveloperLog({ kind: "info", source: "preview scheduler", message: `On-type timer ${this.pdfPreviewScheduleGeneration} replaced by a newer edit.` });
    }
    const scheduleGeneration = ++this.pdfPreviewScheduleGeneration;
    const scheduledPath = this.activeFilePath;
    const debounceMs = this.settingsController.value.preview.syncDebounceMs;
    this.appendDeveloperLog({
      kind: "info",
      source: "preview scheduler",
      message: `On-type timer ${scheduleGeneration} scheduled: active=${scheduledPath ?? "none"}; sourceUtf16=${contents.length}; delay=${debounceMs}ms.`
    });
    this.pdfPreviewTimer = window.setTimeout(() => {
      this.pdfPreviewTimer = null;
      if (this.activeFilePath && filePathKey(this.activeFilePath) === filePathKey(scheduledPath ?? "")) {
        this.appendDeveloperLog({ kind: "info", source: "preview scheduler", message: `On-type timer ${scheduleGeneration} fired.` });
        void this.renderPdfPreview(contents);
      } else {
        this.appendDeveloperLog({
          kind: "info",
          source: "preview scheduler",
          message: `On-type timer ${scheduleGeneration} discarded: active path changed from ${scheduledPath ?? "none"} to ${this.activeFilePath ?? "none"}.`
        });
      }
    }, debounceMs);
  }

  private handleContentMutation(rawText: string) {
    if (!this.isLoadingFile) {
      this.pdfPreparationRevision += 1;
      if (this.settingsController.value.preview.renderMode === "on-type") {
        void invoke("cancel_render_preparation").catch(() => {});
      }
    }
    this.appendDeveloperLog({
      kind: "info",
      source: "preview scheduler",
      message: `Document mutation: active=${this.activeFilePath ?? "none"}; sourceUtf16=${rawText.length}; loading=${this.isLoadingFile}; preparationRevision=${this.pdfPreparationRevision}; mode=${this.settingsController.value.preview.renderMode}; disabled=${this.previewDisabled}; lspReady=${this.lspReady}.`
    });
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
      this.scheduleManualTypographyScaleCheck();
    }

    if (!this.isLoadingFile && this.activeFilePath && this.lspReady && this.lspClient) {
      const version = ++this.currentVersion;
      this.latestDocumentVersion = version;
      const activeTab = this.getActiveTab();
      if (activeTab && activeTab.path === this.activeFilePath) {
        activeTab.version = version;
        activeTab.latestVersion = version;
      }
      if (
        this.previewImported
        && allowsStandalonePreview(rawText) !== this.previewStandalone
        && this.settingsController.value.preview.renderMode === "on-type"
      ) {
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
    if (
      !this.isLoadingFile
      && this.activeFilePath
      && this.activeFilePath.toLowerCase().endsWith(".typ")
      && this.settingsController.value.preview.renderMode === "on-type"
      && !this.previewDisabled
    ) {
      this.schedulePdfPreview(rawText);
    }
  }

  private scheduleManualTypographyScaleCheck(): void {
    if (this.suppressTypographyScaleConfirmation || !this.activeFilePath) return;
    if (this.typographyScaleCheckTimer !== null) window.clearTimeout(this.typographyScaleCheckTimer);
    const generation = ++this.typographyScaleCheckGeneration;
    const delay = Math.max(600, this.settingsController.value.preview.syncDebounceMs);
    this.typographyScaleCheckTimer = window.setTimeout(() => {
      this.typographyScaleCheckTimer = null;
      if (generation !== this.typographyScaleCheckGeneration) return;
      void this.checkManualTypographyScaleChange();
    }, delay);
  }

  private async checkManualTypographyScaleChange(): Promise<void> {
    if (!this.activeFilePath || this.typographyScaleConfirmationOpen) {
      if (this.typographyScaleConfirmationOpen) this.scheduleManualTypographyScaleCheck();
      return;
    }
    const filePath = this.activeFilePath;
    const documentKey = filePathKey(filePath);
    const config = parseTypographyBlock(this.editorInstance.state.doc.toString());
    if (!config) return;
    const previousFallbacks = this.acceptedTypographyScales.get(documentKey) ?? [];
    const signature = (fallbacks: DocumentFontFallback[]) => JSON.stringify(fallbacks.map(fallback => ({
      family: fallback.family,
      script: fallback.script,
      scale: Number(fallback.scale.toFixed(4))
    })));
    if (signature(previousFallbacks) === signature(config.fallbacks)) return;
    const requiresConfirmation = config.fallbacks.some(fallback => {
      if (Math.abs(fallback.scale - 1) <= 0.0001) return false;
      const previous = previousFallbacks.find(candidate =>
        candidate.script === fallback.script && candidate.family === fallback.family
      );
      return !previous || Math.abs(previous.scale - fallback.scale) > 0.0001;
    });

    if (!requiresConfirmation) {
      this.acceptedTypographyScales.set(documentKey, config.fallbacks.map(fallback => ({ ...fallback })));
      await this.applyManualTypographyFontChange(config, filePath);
      return;
    }

    this.typographyScaleConfirmationOpen = true;
    let accepted = false;
    try {
      accepted = await confirm(
        `Apply these document font scales?\n\n${config.fallbacks.map(fallback => `${fallback.family}: ${fallback.scale}×`).join("\n")}\n\nTypsastra will generate scaled workspace fonts and restart the preview compiler.`,
        { title: "Confirm Font Scaling", kind: "warning" }
      );
    } finally {
      this.typographyScaleConfirmationOpen = false;
    }

    if (!this.activeFilePath || filePathKey(this.activeFilePath) !== documentKey) return;
    const currentText = this.editorInstance.state.doc.toString();
    const currentConfig = parseTypographyBlock(currentText);
    if (!currentConfig || signature(currentConfig.fallbacks) !== signature(config.fallbacks)) {
      this.scheduleManualTypographyScaleCheck();
      return;
    }
    if (accepted) {
      this.acceptedTypographyScales.set(documentKey, currentConfig.fallbacks.map(fallback => ({ ...fallback })));
      await this.applyManualTypographyFontChange(currentConfig, filePath);
      return;
    }

    const edit = typographyEdit(currentText, {
      ...currentConfig,
      fallbacks: currentConfig.fallbacks.map(fallback => ({
        ...fallback,
        scale: previousFallbacks.find(candidate =>
          candidate.script === fallback.script && candidate.family === fallback.family
        )?.scale ?? 1
      }))
    });
    this.suppressTypographyScaleConfirmation = true;
    try {
      this.editorInstance.dispatch({
        changes: edit,
        userEvent: "input.typography-scale-revert"
      });
    } finally {
      this.suppressTypographyScaleConfirmation = false;
    }
  }

  private async applyManualTypographyFontChange(config: DocumentTypography, filePath: string): Promise<void> {
    try {
      const fontsChanged = await this.updateWorkspaceTypographyFont(config);
      if (!fontsChanged) return;
      if (this.activeFilePath && filePathKey(this.activeFilePath) === filePathKey(filePath)) {
        await this.refreshActivePreviewRoot(true);
      }
    } catch (error) {
      this.appendLspLog({
        kind: "error",
        source: "typography",
        message: `Unable to prepare the manually selected font scale: ${String(error)}`
      });
      await message(String(error), { title: "Unable to Scale Font", kind: "error" });
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
    if (!this.isLspSyncVersionCurrent(path, version)) return;
    const { uri: lspUri, content: lspContent } = lspRes;
    await this.openDocumentIfNeeded(lspUri, lspContent, version);
    if (!this.isLspSyncVersionCurrent(path, version)) return;
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

  private isLspSyncVersionCurrent(path: string, version: number): boolean {
    const activeTab = this.getActiveTab();
    if (activeTab && filePathKey(activeTab.path) === filePathKey(path) && activeTab.latestVersion > version) {
      return false;
    }
    if (
      this.pendingLspSyncPath &&
      filePathKey(this.pendingLspSyncPath) === filePathKey(path) &&
      typeof this.pendingLspSyncVersion === "number" &&
      this.pendingLspSyncVersion > version
    ) {
      return false;
    }
    return true;
  }


  private async handleInverseSync(uri: string | undefined, position: LspSourcePosition): Promise<LspInverseSyncResult> {
    this.appendDeveloperLog({
      kind: "info",
      source: "inverse sync",
      message: `Compiler source response: uri=${uri ?? "n/a"}, line=${position.line}, character=${position.character ?? 0}.`
    });
    if (!this.previewSyncController.hasRecentPreviewClick()) {
      this.appendDeveloperLog({
        kind: "warning",
        source: "inverse sync",
        message: "Ignored inverse sync because it did not originate from Typsastra's docked DOM-intercepted preview."
      });
      return { handled: true };
    }

    const rawTargetPath = uri ? filePathFromUri(uri) : null;
    let targetPath = rawTargetPath ? this.mapToOriginalPath(rawTargetPath) : null;
    const existingTargetTab = targetPath
      ? this.openTabs.find((tab) => filePathKey(tab.path) === filePathKey(targetPath))
      : null;
    const resolvedTargetPath = existingTargetTab?.path ?? targetPath;
    if (resolvedTargetPath && filePathKey(resolvedTargetPath) !== filePathKey(this.activeFilePath ?? "")) {
      let isStandalone = false;
      if (existingTargetTab) {
        isStandalone = allowsStandalonePreview(existingTargetTab.content);
      } else {
        try {
          const contents = await invoke<string>("read_workspace_file", { path: resolvedTargetPath });
          isStandalone = allowsStandalonePreview(contents);
        } catch {
          // ignore
        }
      }
      await this.loadFile(resolvedTargetPath, {
        preservePreviewSession: isStandalone ? undefined : this.capturePreviewSession()
      });
    }

    if (this.activeMode === "WYSIWYM") {
      this.switchViewLayoutMode();
    }

    this.previewSyncController.clearForward();
    
    let cursor = 0;
    if (rawTargetPath && targetPath && this.isRenderCachePath(rawTargetPath)) {
      const relPath = targetPath.startsWith(this.workspaceRootPath!)
        ? targetPath.substring(this.workspaceRootPath!.length).replace(/^[/\\]+/, "")
        : targetPath;
      const cacheContent = await this.pdfGeneratedPreviewText(targetPath);
      cursor = await this.mapCacheLspPositionToOriginalEditorOffset(relPath, position, cacheContent) ?? 0;
    } else {
      cursor = this.editorPositionFromLspPosition(position) ?? 0;
      this.appendDeveloperLog({
        kind: "info",
        source: "inverse sync",
        message: `Compiler inverse position mapped directly: line=${position.line + 1}, character=${position.character ?? 0}, offset=${cursor}.`
      });
    }

    await this.applyInverseSyncSelection(cursor);
    return { handled: true };
  }

  private async applyInverseSyncSelection(cursor: number): Promise<void> {
    const editor = this.editorInstance;
    const target = Math.max(0, Math.min(cursor, editor.state.doc.length));
    await nextAnimationFrame();
    editor.dispatch({
      selection: { anchor: target },
      effects: EditorView.scrollIntoView(target, { y: "center" })
    });
    editor.focus();
    window.setTimeout(() => {
      if (this.editorInstance !== editor) return;
      if (editor.state.selection.main.head !== target) return;
      editor.dispatch({
        effects: EditorView.scrollIntoView(target, { y: "center" })
      });
    }, 60);
    this.scheduleEditorCaretRipple(editor, target);
    this.appendDeveloperLog({
      kind: "info",
      source: "inverse sync",
      message: `Editor inverse position applied: offset=${target}.`
    });
  }

  private scheduleEditorCaretRipple(editor: EditorView, cursor: number): void {
    let shown = false;
    const show = () => {
      if (shown) return;
      if (this.editorInstance !== editor) return;
      if (editor.state.selection.main.head !== cursor) return;
      shown = this.showEditorCaretRipple(editor, cursor);
    };
    window.setTimeout(show, 90);
    window.setTimeout(show, 180);
  }

  private showEditorCaretRipple(editor: EditorView, cursor: number): boolean {
    const coords = editor.coordsAtPos(cursor);
    if (!coords) return false;
    document.querySelectorAll(".typsastra-editor-caret-ripple").forEach(element => element.remove());
    const ripple = document.createElement("div");
    ripple.className = "typsastra-editor-caret-ripple";
    Object.assign(ripple.style, {
      position: "fixed",
      left: `${coords.left}px`,
      top: `${(coords.top + coords.bottom) / 2}px`,
      width: "18px",
      height: "18px",
      margin: "-9px 0 0 -9px",
      border: `2px solid ${TYPSASTRA_GREEN}`,
      borderRadius: "999px",
      background: TYPSASTRA_GREEN_RIPPLE_FILL,
      boxShadow: `0 0 0 0 ${TYPSASTRA_GREEN_RIPPLE_SHADOW}`,
      pointerEvents: "none",
      zIndex: "2147483647",
      animation: "typsastra-editor-caret-ripple 900ms ease-out forwards"
    });
    ensureEditorCaretRippleStyle();
    document.body.appendChild(ripple);
    window.setTimeout(() => {
      if (ripple.isConnected) ripple.remove();
    }, 1000);
    return true;
  }

  private async handlePdfForwardSync(path: string, cursor: number, requestedGeneration?: number): Promise<boolean> {
    const generation = requestedGeneration ?? ++this.pdfForwardSyncGeneration;
    const client = this.lspClient;
    const rootPath = this.pdfPreviewSourceMapRootPath ?? this.previewRootPath;
    const taskId = this.pdfPreviewSourceMapTaskId ?? this.previewTaskId;
    if (!client || !rootPath || !taskId || !this.lspReady || !this.previewFrame.currentUrl) {
      this.appendDeveloperLog({
        kind: "info",
        source: "forward sync",
        message: `Skipped forward sync: client=${!!client}, root=${rootPath ?? "n/a"}, task=${taskId ?? "n/a"}, lspReady=${this.lspReady}, preview=${this.previewFrame.currentUrl || "n/a"}.`
      });
      return false;
    }

    const targets = await this.forwardSyncTargets(path, cursor);
    if (generation !== this.pdfForwardSyncGeneration) return false;
    if (targets.length === 0) {
      this.appendDeveloperLog({
        kind: "warning",
        source: "forward sync",
        message: `Skipped forward sync: could not map editor cursor ${cursor} for ${path}.`
      });
      return false;
    }

    const sourceMapSession = await this.ensurePdfSourceMapSocket(client, rootPath, taskId, "forward sync");
    if (generation !== this.pdfForwardSyncGeneration) return false;
    if (!sourceMapSession) {
      this.appendDeveloperLog({
        kind: "warning",
        source: "forward sync",
        message: "Skipped PDF forward sync: source-map socket unavailable."
      });
      return false;
    }

    this.pendingPdfForwardSync = { generation, requestedAt: Date.now() };
    window.setTimeout(() => {
      if (this.pendingPdfForwardSync?.generation === generation) {
        this.pendingPdfForwardSync = null;
        this.appendDeveloperLog({
          kind: "warning",
          source: "forward sync",
          message: "Forward sync timed out waiting for Tinymist source-map position."
        });
        this.finishManualForwardSync(generation, "Reveal in preview timed out");
      }
    }, 5000);

    void this.sendForwardSyncTargets(client, sourceMapSession.taskId, targets, generation);
    const target = targets[0];
    this.appendDeveloperLog({
      kind: "info",
      source: "forward sync",
      message: `Requested compiler preview position: ${target.filepath}:${target.line + 1}:${target.character}; nearbyCandidates=${targets.length}.`
    });
    return true;
  }

  private async sendForwardSyncTargets(
    client: TinymistLspClient,
    taskId: string,
    targets: Array<{ filepath: string; line: number; character: number }>,
    generation: number
  ): Promise<void> {
    for (let index = 0; index < targets.length; index += 1) {
      if (this.pendingPdfForwardSync?.generation !== generation) return;
      const target = targets[index];
      await client.scrollPreview(taskId, {
        event: "panelScrollTo",
        filepath: nativeFilePath(target.filepath),
        line: target.line,
        character: target.character
      });
      if (index + 1 < targets.length) await new Promise(resolve => window.setTimeout(resolve, 180));
    }
  }

  private revealCursorInPreviewManually(): void {
    const path = this.activeFilePath;
    if (!path?.toLowerCase().endsWith(".typ")) {
      this.setLspStatus({ kind: "preview-ready", message: "Open a Typst file to reveal it in preview" });
      return;
    }
    const request = { path, cursor: this.editorInstance.state.selection.main.head };
    if (this.manualForwardSyncGeneration !== null) {
      // Tinymist source-map responses do not carry request IDs. Keep only the
      // latest target and send it after the active request settles, so an old
      // response can never be mistaken for a newer cursor position.
      this.queuedManualForwardSync = request;
      this.setLspStatus({ kind: "sync-pending", message: "Latest preview reveal queued" });
      return;
    }
    if (!this.canRevealCursorInPreview()) {
      this.setLspStatus({ kind: "preview-ready", message: "Wait for the compiled preview before revealing the cursor" });
      return;
    }
    void this.runManualForwardSync(request);
  }

  private async runManualForwardSync(request: { path: string; cursor: number }): Promise<void> {
    const generation = ++this.pdfForwardSyncGeneration;
    this.manualForwardSyncGeneration = generation;
    this.pendingPdfForwardSync = null;
    this.updateManualForwardSyncAction();
    this.setLspStatus({ kind: "sync-pending", message: "Locating cursor in preview..." });
    try {
      const requested = await this.handlePdfForwardSync(request.path, request.cursor, generation);
      if (!requested && generation === this.manualForwardSyncGeneration) {
        this.finishManualForwardSync(generation, "Could not locate cursor in preview");
      }
    } catch (error) {
      this.appendDeveloperLog({
        kind: "warning",
        source: "forward sync",
        message: `Manual forward sync failed: ${String(error)}`
      });
      this.finishManualForwardSync(generation, "Could not locate cursor in preview");
    }
  }

  private finishManualForwardSync(generation: number, statusMessage: string): void {
    if (this.manualForwardSyncGeneration !== generation) return;
    this.manualForwardSyncGeneration = null;
    this.setLspStatus({ kind: "preview-ready", message: statusMessage });
    this.updateManualForwardSyncAction();
    const queued = this.queuedManualForwardSync;
    this.queuedManualForwardSync = null;
    if (queued) void this.runManualForwardSync(queued);
  }

  private cancelManualForwardSync(): void {
    if (
      this.manualForwardSyncGeneration === null
      && this.pendingPdfForwardSync === null
      && this.queuedManualForwardSync === null
    ) return;
    ++this.pdfForwardSyncGeneration;
    this.pendingPdfForwardSync = null;
    this.manualForwardSyncGeneration = null;
    this.queuedManualForwardSync = null;
    this.updateManualForwardSyncAction();
  }

  private updateManualForwardSyncAction(): void {
    const button = document.getElementById("preview-forward-sync-btn") as HTMLButtonElement | null;
    if (!button) return;
    const shortcut = navigator.userAgent.toLowerCase().includes("mac") ? "Option+Enter" : "Alt+Enter";
    const busy = this.manualForwardSyncGeneration !== null;
    const available = this.canRevealCursorInPreview();
    button.disabled = busy || !available;
    button.setAttribute("aria-busy", String(busy));
    button.title = busy
      ? "Locating cursor in preview..."
      : available
        ? `Reveal Cursor in Preview (${shortcut})`
        : "Reveal cursor is available when a compiled preview is ready";
  }

  private canRevealCursorInPreview(): boolean {
    return Boolean(
      this.activeFilePath?.toLowerCase().endsWith(".typ")
      && this.lspReady
      && this.previewFrame.currentUrl
      && !this.pdfPreviewRunning
      && !this.previewDisabled
    );
  }

  private async forwardSyncTargets(path: string, cursor: number): Promise<Array<{ filepath: string; line: number; character: number }>> {
    const editor = this.editorInstance;
    const position = Math.max(0, Math.min(cursor, editor.state.doc.length));
    // Template-aware standalone wrappers use workspace-root (`/...`) imports.
    // Those imports retain the original source IDs even when the wrapper itself
    // is mirrored into the render cache.
    const generated = usesTemplateAwareStandaloneRoot(path, this.previewRootPath, this.previewStandalone)
      ? undefined
      : this.pdfPreviewGeneratedFiles.get(filePathKey(path));
    if (!generated) {
      const line = editor.state.doc.lineAt(position);
      return tinymistPreviewNearbySourceColumns(line.text, position - line.from).map(character => ({
        filepath: path,
        line: line.number - 1,
        character
      }));
    }

    const cacheRoot = this.getCacheRootPath();
    if (!cacheRoot || !this.workspaceRootPath) return [];

    const originalContent = editor.state.doc.toString();
    const sourceByteOffset = new TextEncoder().encode(originalContent.slice(0, position)).length;
    const relativePath = path.startsWith(this.workspaceRootPath)
      ? path.substring(this.workspaceRootPath.length).replace(/^[/\\]+/, "")
      : path;
    const generatedByteOffset = await invoke<number | null>("map_source_to_generated", {
      cacheRoot,
      relativePath,
      sourceOffset: sourceByteOffset
    }).catch(() => null);
    if (generatedByteOffset === null || generatedByteOffset === undefined) return [];

    const generatedOffset = this.utf8ByteOffsetToStringOffset(generated.preparedText, generatedByteOffset);
    const generatedDoc = EditorState.create({ doc: generated.preparedText }).doc;
    const line = generatedDoc.lineAt(Math.max(0, Math.min(generatedOffset, generatedDoc.length)));
    return tinymistPreviewNearbySourceColumns(line.text, generatedOffset - line.from).map(character => ({
      filepath: generated.generatedPath,
      line: line.number - 1,
      character
    }));
  }

  private async ensurePdfSourceMapSocket(
    client: TinymistLspClient,
    rootPath: string,
    taskId: string,
    source: "forward sync" | "inverse sync"
  ): Promise<{ socket: WebSocket; taskId: string } | null> {
    const sourceMapTaskId = sourceMapPreviewTaskId(taskId);
    const taskKey = `${filePathKey(rootPath)}\u0000${sourceMapTaskId}`;
    if (this.pdfSourceMapStartupKey === taskKey && this.pdfSourceMapStartup) {
      return await this.pdfSourceMapStartup;
    }

    const startup = this.startPdfSourceMapSession(client, rootPath, taskId, sourceMapTaskId, taskKey, source);
    this.pdfSourceMapStartupKey = taskKey;
    this.pdfSourceMapStartup = startup;
    try {
      return await startup;
    } finally {
      if (this.pdfSourceMapStartup === startup) {
        this.pdfSourceMapStartup = null;
        this.pdfSourceMapStartupKey = null;
      }
    }
  }

  private async startPdfSourceMapSession(
    client: TinymistLspClient,
    rootPath: string,
    legacyTaskId: string,
    sourceMapTaskId: string,
    taskKey: string,
    source: "forward sync" | "inverse sync"
  ): Promise<{ socket: WebSocket; taskId: string } | null> {
    if (this.pdfSyncPreviewTaskKey === taskKey) {
      const existingSocket = await this.ensurePdfSyncSocket(client.getLatestPreviewDataPlaneUrl(), source);
      if (existingSocket) return { socket: existingSocket, taskId: sourceMapTaskId };
    }

    this.pdfSyncSocket?.close();
    this.pdfSyncSocket = null;
    this.pdfSyncSocketUrl = "";

    const staleTasks = staleSourceMapTaskIds(legacyTaskId, this.pdfSyncRegisteredTaskId);
    for (const staleTaskId of staleTasks) {
      await client.stopPreview(staleTaskId).catch(() => {});
    }
    this.pdfSyncPreviewTaskKey = null;
    this.pdfSyncRegisteredTaskId = null;

    this.appendDeveloperLog({
      kind: "info",
      source,
      message: `Starting hidden Tinymist source-map session: root=${rootPath}; task=${sourceMapTaskId}; mode=${previewRefreshStyle(this.settingsController.value.preview.renderMode)}; active=${this.activeFilePath ?? "n/a"}.`
    });
    const url = await client.startPreview(
      nativeFilePath(rootPath),
      sourceMapTaskId,
      previewRefreshStyle(this.settingsController.value.preview.renderMode),
      false
    );
    if (!url) {
      this.appendDeveloperLog({
        kind: "warning",
        source,
        message: `Tinymist source-map session failed to start for task ${sourceMapTaskId}.`
      });
      return null;
    }
    this.pdfSyncPreviewTaskKey = taskKey;
    this.pdfSyncRegisteredTaskId = sourceMapTaskId;

    const dataPlaneUrl = client.getLatestPreviewDataPlaneUrl();
    const socket = await this.ensurePdfSyncSocket(dataPlaneUrl, source);
    if (socket) return { socket, taskId: sourceMapTaskId };

    this.appendDeveloperLog({
      kind: "warning",
      source,
      message: `Tinymist data-plane connection failed for task ${sourceMapTaskId}: ${dataPlaneUrl || "URL unavailable"}.`
    });
    await client.stopPreview(sourceMapTaskId).catch(() => {});
    if (this.pdfSyncRegisteredTaskId === sourceMapTaskId) this.pdfSyncRegisteredTaskId = null;
    if (this.pdfSyncPreviewTaskKey === taskKey) this.pdfSyncPreviewTaskKey = null;
    return null;
  }

  private async handlePdfPreviewClick(point: PreviewClickPoint): Promise<void> {
    const isPreviewWindow = isPreviewOnlyWindow();
    if (isPreviewWindow) {
      import("@tauri-apps/api/event").then(({ emit }) => {
        emit("pdf-click", point);
      }).catch(err => console.error("Error emitting pdf-click", err));
      return;
    }
    const position = point.documentPosition;
    const client = this.lspClient;
    // The displayed PDF may have been compiled from the prepared render cache.
    // Its physical coordinates are only meaningful to the source-map session
    // for that exact generated entry file, not the original workspace preview.
    const rootPath = this.pdfPreviewSourceMapRootPath ?? this.previewRootPath;
    const taskId = this.pdfPreviewSourceMapTaskId ?? this.previewTaskId;
    if (!position || !client || !rootPath || !taskId || !this.lspReady) {
      this.appendDeveloperLog({
        kind: "warning",
        source: "inverse sync",
        message: `Skipped PDF inverse sync: position=${!!position}, client=${!!client}, root=${rootPath ?? "n/a"}, task=${taskId ?? "n/a"}, lspReady=${this.lspReady}.`
      });
      return;
    }

    const sourceMapSession = await this.ensurePdfSourceMapSocket(client, rootPath, taskId, "inverse sync");
    if (!sourceMapSession) {
      this.appendDeveloperLog({
        kind: "warning",
        source: "inverse sync",
        message: "Skipped PDF inverse sync: source-map socket unavailable."
      });
      return;
    }
    this.previewSyncController.recordPreviewClick(point);
    this.appendDeveloperLog({
      kind: "info",
      source: "inverse sync",
      message: `Sending compiler inverse position: page=${position.page_no}, x=${position.x.toFixed(2)}, y=${position.y.toFixed(2)}, root=${rootPath}.`
    });
    sourceMapSession.socket.send(`src-point ${JSON.stringify(position)}`);
  }

  private async ensurePdfSyncSocket(url: string, source: "forward sync" | "inverse sync"): Promise<WebSocket | null> {
    if (!url) return null;
    if (this.pdfSyncSocketUrl === url && this.pdfSyncSocket?.readyState === WebSocket.OPEN) {
      return this.pdfSyncSocket;
    }
    this.pdfSyncSocket?.close();
    this.pdfSyncSocket = null;
    this.pdfSyncSocketUrl = url;
    const proxyUrl = await invoke<string>("start_preview_ws_proxy", { targetUrl: url }).catch(error => {
      this.appendDeveloperLog({
        kind: "warning",
        source,
        message: `Failed to start native Tinymist data-plane bridge for ${url}: ${String(error)}`
      });
      return "";
    });
    if (!proxyUrl || this.pdfSyncSocketUrl !== url) return null;
    return await new Promise(resolve => {
      // Tinymist validates WebSocket origins. The native loopback bridge sets
      // the upstream Origin to the Tinymist endpoint while this browser-facing
      // socket remains confined to a one-connection local proxy.
      const socket = new WebSocket(proxyUrl);
      socket.binaryType = "arraybuffer";
      let settled = false;
      const finish = (value: WebSocket | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(value);
      };
      const timeout = window.setTimeout(() => {
        socket.close();
        if (this.pdfSyncSocket === socket) this.pdfSyncSocket = null;
        finish(null);
      }, 10000);
      socket.addEventListener("open", () => {
        this.pdfSyncSocket = socket;
        socket.send("current");
        this.appendDeveloperLog({
          kind: "info",
          source,
          message: `Tinymist data-plane connected: ${url}.`
        });
      }, { once: true });
      socket.addEventListener("message", event => {
        // The first payload is the response to `current` (normally a binary
        // diff-v1 snapshot). Wait for it before issuing source-map commands.
        finish(socket);
        void this.handlePdfSyncSocketMessage(event.data);
      });
      socket.addEventListener("close", () => {
        if (this.pdfSyncSocket === socket) this.pdfSyncSocket = null;
      });
      socket.addEventListener("error", () => {
        if (this.pdfSyncSocket === socket) this.pdfSyncSocket = null;
        finish(null);
      }, { once: true });
    });
  }

  private async handlePdfSyncSocketMessage(data: unknown): Promise<void> {
    const text = await tinymistDataPlanePositionText(data);
    if (!text) return;
    const positions = parseTinymistPreviewPositions(text);
    if (positions.length === 0) {
      if (this.pendingPdfForwardSync) {
        this.appendDeveloperLog({
          kind: "info",
          source: "forward sync",
          message: `Ignored source-map payload without PDF position: ${sanitizeLogText(text).slice(0, 120)}`
        });
      }
      return;
    }

    const pending = this.pendingPdfForwardSync;
    if (!pending || Date.now() - pending.requestedAt > 5000) return;
    this.pendingPdfForwardSync = null;

    const position = positions[0];
    this.appendDeveloperLog({
      kind: "info",
      source: "forward sync",
      message: `Compiler document position: candidates=${positions.length}, page=${position.page_no}, x=${position.x.toFixed(2)}, y=${position.y.toFixed(2)}.`
    });
    void this.previewFrame.revealDocumentPosition(position, { ripple: true });
    this.finishManualForwardSync(pending.generation, "Cursor revealed in preview");
    import("@tauri-apps/api/event").then(({ emit }) => {
      emit("pdf-forward-sync", position);
    }).catch(err => console.error("Error emitting pdf-forward-sync", err));
  }
  private updatePreviewZoomLabel(zoomPercent?: number) {
    const label = document.getElementById("preview-zoom-label");
    if (!label) return;

    if (this.imageZoomPercent && this.imageIsFit) {
      const isFit = this.imageIsFit();
      const pct = Math.round((zoomPercent ?? this.imageZoomPercent()) * 100);
      label.textContent = isFit ? "Fit" : `${pct}%`;
    } else {
      const pct = zoomPercent ?? this.previewFrame.currentZoomPercent;
      label.textContent = this.previewFrame.isFitMode ? "Fit" : `${pct}%`;
    }
  }

  private updatePreviewActionsToolbar(path: string | null): void {
    const previewActions = document.querySelector(".preview-actions");
    if (!previewActions) return;

    if (!path) {
      previewActions.classList.add("hidden");
      return;
    }

    const ext = fileExtension(path);
    const isImage = isBinaryImagePath(path);
    const isPdf = ext === "pdf";
    const isUnsupported = !isSupportedInAppPath(path);

    if (isUnsupported && !isImage && !isPdf) {
      previewActions.classList.add("hidden");
      return;
    }

    previewActions.classList.remove("hidden");

    const showTypstOnly = !isImage && !isPdf;

    const syncBtn = document.getElementById("preview-forward-sync-btn");
    const recompileBtn = document.getElementById("preview-recompile-btn");
    const menuBtn = document.getElementById("preview-menu-btn");

    if (syncBtn) {
      if (showTypstOnly) syncBtn.classList.remove("hidden");
      else syncBtn.classList.add("hidden");
    }
    if (recompileBtn) {
      if (showTypstOnly) recompileBtn.classList.remove("hidden");
      else recompileBtn.classList.add("hidden");
    }
    if (menuBtn) {
      if (showTypstOnly) menuBtn.classList.remove("hidden");
      else menuBtn.classList.add("hidden");
    }
  }

  private zoomIn(): void {
    if (this.imageZoomIn) {
      this.imageZoomIn();
    } else {
      this.previewFrame.zoomIn();
      this.updatePreviewZoomLabel();
    }
  }

  private zoomOut(): void {
    if (this.imageZoomOut) {
      this.imageZoomOut();
    } else {
      this.previewFrame.zoomOut();
      this.updatePreviewZoomLabel();
    }
  }

  private zoomToFit(): void {
    if (this.imageZoomToFit) {
      this.imageZoomToFit();
    } else {
      this.previewFrame.zoomToFit();
      this.updatePreviewZoomLabel();
    }
  }

  private recordStartupTiming(source: string, label: string, start: number): void {
    this.recordStartupTimingEntry({ source, label, ms: performance.now() - start });
  }

  private recordStartupTimingEntry(entry: StartupTimingEntry): void {
    this.startupTimings.push(entry);
    this.logStartupTimingToConsole(entry);
  }

  private logStartupTimingToConsole(entry: StartupTimingEntry): void {
    if (!this.isDeveloperLogEnabled("performance")) return;
    console.info(`[startup timing] ${entry.source}: ${entry.label} took ${entry.ms.toFixed(1)} ms`);
  }

  private async logNativeStartupTimingsToConsole(): Promise<void> {
    if (!this.isDeveloperLogEnabled("performance")) return;
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
    const startedAt = performance.now();
    try {
      const providers = await this.timeStartup("finish native startup initialization", () =>
        invoke<unknown>("finish_startup_initialization")
      );
      this.spellcheckController.setProviders(providers);
      this.settingsController.setLanguageProviders(this.spellcheckController.getAllProviders());
      this.performanceDiagnostics.recordFirst({
        name: "startup.providers",
        milliseconds: performance.now() - startedAt,
        detail: { providerCount: this.spellcheckController.getAllProviders().length }
      });
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
      this.setLspStatus({ kind: "preview-ready", message: "Inverse sync source-map active" });
      this.appendDeveloperLog({
        kind: "info",
        source: "inverse sync",
        message: `Preview source-map click interception installed for ${status.url}`
      });
      return;
    }
    this.setLspStatus({ kind: "preview-ready", message: "Inverse sync source-map blocked" });
    this.appendDeveloperLog({
      kind: "warning",
      source: "inverse sync",
      message: `Preview source-map click interception blocked for ${status.url}: ${status.reason ?? "unknown reason"}. Inverse sync will use Tinymist's raw source position only.`
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
    this.updateManualForwardSyncAction();
  }

  private async handleLspDiagnostics(uri: string, diagnostics: LspDiagnostic[], version?: number) {
    const originalPath = this.mapToOriginalPath(filePathFromUri(uri));
    const isActive = this.activeFilePath && filePathKey(originalPath) === filePathKey(this.activeFilePath);
    if (isActive && this.diagnosticWaitStartedAt !== null) {
      this.performanceDiagnostics.recordFirst({
        name: "diagnostics.first",
        milliseconds: performance.now() - this.diagnosticWaitStartedAt,
        detail: { diagnosticCount: diagnostics.length }
      });
      this.diagnosticWaitStartedAt = null;
    }

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
      const rawPath = filePathFromUri(uri);
      const fromRenderCache = this.isRenderCachePath(rawPath);
      const relPath = originalPath.startsWith(this.workspaceRootPath!)
        ? originalPath.substring(this.workspaceRootPath!.length).replace(/^[/\\]+/, "")
        : originalPath;
      const cacheContent = fromRenderCache ? await this.pdfGeneratedPreviewText(originalPath) : "";

      for (const diagnostic of filteredDiagnostics) {
        let from: number | null = null;
        let to: number | null = null;
        if (fromRenderCache) {
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

    if (this.settingsController.value.preview.renderMode === "on-type") {
      if (this.logConsoleController.getErrorCount() > 0) {
        this.previewFrame.setError("Preview Render Failed", "The live preview cannot be updated because of compile errors.\nPlease check the Problems panel or Log Console for details.");
      } else {
        this.previewFrame.clearErrorOverlay();
      }
    }
  }



  private diagnosticSourceText(diagnostic: LspDiagnostic): string {
    const from = this.editorPositionFromLspPosition(diagnostic.range.start);
    const to = this.editorPositionFromLspPosition(diagnostic.range.end);
    if (from === null || to === null) return "";
    return this.editorInstance.state.doc.sliceString(from, Math.max(from, to));
  }

  private logEntryFromDiagnostic(uri: string, diagnostic: LspDiagnostic): LogConsoleEntryInput {
    const filePath = this.mapToOriginalPath(filePathFromUri(uri));
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
    const source = entry.source ?? "developer";
    if (!this.isDeveloperLogEnabled(this.developerLogCategory(source))) return;
    this.logConsoleController.appendLog({
      kind: entry.kind,
      source,
      message: entry.message,
      channel: "dev"
    });
  }

  private developerLogCategory(source: string): DeveloperLogCategory {
    const normalized = source.toLocaleLowerCase();
    if (normalized.includes("inverse sync")) return "inverseSync";
    if (normalized.includes("forward sync")) return "forwardSync";
    if (normalized.includes("memory")) return "memory";
    if (normalized.includes("performance")) return "performance";
    if (normalized.includes("preview")) return "preview";
    if (normalized.includes("lsp") || normalized.includes("tinymist") || normalized.includes("toolchain")) return "lsp";
    return "general";
  }

  private isDeveloperLogEnabled(category: DeveloperLogCategory): boolean {
    const settings = this.settingsController.value;
    return settings.developerMode && settings.developerLogs[category];
  }

  private updateSpellcheckLog(issues: readonly SpellingIssue[]): void {
    const filePath = this.activeFilePath;
    if (!filePath || !this.editorInstance) {
      this.logConsoleController.setSpellcheckIssues([]);
      return;
    }
    const doc = this.editorInstance.state.doc;
    const grouped = new Map<string, {
      issue: SpellingIssue;
      providers: Set<string>;
      locations: Array<{
        filePath: string;
        fileName: string;
        line: number;
        column: number;
        offset: number;
        toOffset: number;
      }>;
      offsets: Set<string>;
    }>();
    for (const issue of issues) {
      // Preserve the source spelling exactly. Case and Unicode form are part
      // of the displayed word's identity even if providers normalize lookup.
      const key = spellcheckConsoleGroupKey(issue.sourceText, issue.ignored);
      const group = grouped.get(key) ?? {
        issue,
        providers: new Set<string>(),
        locations: [],
        offsets: new Set<string>()
      };
      group.providers.add(issue.provider);
      const offset = Math.max(0, Math.min(issue.from, doc.length));
      const toOffset = Math.max(offset, Math.min(issue.to, doc.length));
      const offsetKey = `${offset}:${toOffset}`;
      if (!group.offsets.has(offsetKey)) {
        const line = doc.lineAt(offset);
        group.offsets.add(offsetKey);
        group.locations.push({
          filePath,
          fileName: fileNameFromPath(filePath),
          line: line.number,
          column: offset - line.from + 1,
          offset,
          toOffset
        });
      }
      grouped.set(key, group);
    }
    this.logConsoleController.setSpellcheckIssues([...grouped.values()].map(group => ({
      kind: group.issue.ignored ? "info" : "warning",
      channel: "spellcheck",
      counted: !group.issue.ignored,
      source: [...group.providers].join(", "),
      filePath,
      fileName: fileNameFromPath(filePath),
      message: `${group.issue.ignored ? "Ignored unknown word" : "Unknown word"}: “${group.issue.sourceText}”`,
      locations: group.locations
    })));
    this.syncSelectedSpellingLocation();
  }

  private syncSelectedSpellingLocation(): void {
    if (!this.activeFilePath || !this.editorInstance) {
      this.logConsoleController.setActiveSpellcheckLocation(null);
      return;
    }
    const selection = this.editorInstance.state.selection.main;
    const issue = this.spellcheckController.issueAt(selection.from < selection.to ? selection.from : selection.head);
    this.logConsoleController.setActiveSpellcheckLocation(
      issue ? this.activeFilePath : null,
      issue?.from,
      issue?.to
    );
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
    const rawPath = filePathFromUri(uri);
    let filePath = this.mapToOriginalPath(rawPath);
    if (filePath !== this.activeFilePath) {
      await this.loadFile(filePath);
    }
    
    let cursor = 0;
    if (this.isRenderCachePath(rawPath) && this.lspClient) {
      const relPath = filePath.startsWith(this.workspaceRootPath!)
        ? filePath.substring(this.workspaceRootPath!.length).replace(/^[/\\]+/, "")
        : filePath;
      const cacheContent = await this.pdfGeneratedPreviewText(filePath);
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
      await this.loadFile(heading.filePath, { focusEditor: false });
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
    if (!this.wysiwymPane) return;
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

  private saveWorkspaceState(): Promise<void> {
    if (!this.workspaceRootPath || !this.workspaceMetadata) return Promise.resolve();
    
    this.persistActiveTabState();
    
    const inputContainer = document.getElementById("input-container-wrapper");
    const explorerSidebar = document.getElementById("explorer-sidebar");
    
    const relative = (path: string | null): string | null => path && this.workspaceRootPath
      ? relativeFilePath(this.workspaceRootPath, path)?.replace(/\\/g, "/") ?? null
      : null;
    const metadata: WorkspaceMetadata = {
      project: {
        ...this.workspaceMetadata.project,
        mainFile: relative(this.pinnedMainFilePath),
        recommendedToolchain: this.recommendedWorkspaceToolchain
      },
      workspace: {
        schemaVersion: 1,
        activeFile: relative(this.activeFilePath),
        openTabs: this.openTabs.flatMap(tab => {
          const path = relative(tab.path);
          return path ? [{
            path,
            selectionAnchor: tab.selectionAnchor,
            selectionHead: tab.selectionHead,
            scrollTop: tab.scrollTop,
            scrollLeft: tab.scrollLeft,
            foldRanges: tab.foldRanges
          }] : [];
        }),
        expandedDirectories: this.explorer.expandedDirectoryPaths().flatMap(path => {
          const directory = relative(path);
          return directory ? [directory] : [];
        }),
        layout: {
          inputContainerWidthPct: inputContainer?.style.width ? parseFloat(inputContainer.style.width) : DEFAULT_INPUT_WIDTH_PCT,
          explorerSidebarWidthPx: explorerSidebar?.style.width ? parseInt(explorerSidebar.style.width, 10) : DEFAULT_EXPLORER_WIDTH_PX,
          sidebarVisible: this.sidebarVisible
        },
        selectedToolchain: this.selectedWorkspaceToolchain
      }
    };
    this.workspaceMetadata = metadata;
    return this.workspaceStateStore.save(this.workspaceRootPath, metadata).catch(error => {
      this.appendDeveloperLog({ kind: "error", source: "workspace", message: `Failed to save workspace state: ${String(error)}` });
    });
  }

  private migrateLegacyWorkspaceState(workspacePath: string, legacy: LegacyWorkspaceState): WorkspaceMetadata {
    const relative = (path: string | null): string | null => path
      ? relativeFilePath(workspacePath, path)?.replace(/\\/g, "/") ?? null
      : null;
    const metadata = normalizeWorkspaceMetadata({ project: null, workspace: null });
    metadata.project.mainFile = relative(legacy.pinnedMainFilePath);
    metadata.project.recommendedToolchain = legacy.recommendedToolchain;
    metadata.workspace.activeFile = relative(legacy.activeFilePath);
    metadata.workspace.openTabs = legacy.openTabs.flatMap(tab => {
      const path = relative(tab.path);
      return path ? [{ ...tab, path }] : [];
    });
    metadata.workspace.expandedDirectories = [];
    metadata.workspace.layout = {
      inputContainerWidthPct: legacy.inputContainerWidthPct,
      explorerSidebarWidthPx: legacy.explorerSidebarWidthPx,
      sidebarVisible: true
    };
    metadata.workspace.selectedToolchain = legacy.selectedToolchain;
    return metadata;
  }

  private async loadWorkspaceMetadata(workspacePath: string): Promise<WorkspaceMetadata> {
    const stored = await this.workspaceStateStore.load(workspacePath);
    if (stored) return stored;
    const legacy = this.workspaceStateStore.loadLegacy(workspacePath);
    const metadata = legacy
      ? this.migrateLegacyWorkspaceState(workspacePath, legacy)
      : normalizeWorkspaceMetadata({ project: null, workspace: null });
    await this.workspaceStateStore.save(workspacePath, metadata);
    if (legacy) this.workspaceStateStore.removeLegacy(workspacePath);
    return metadata;
  }

  private async absoluteWorkspacePath(workspacePath: string, relativePath: string | null): Promise<string | null> {
    return relativePath ? join(workspacePath, relativePath) : null;
  }

  private async restoreWorkspaceState(workspacePath: string, metadata: WorkspaceMetadata) {
    try {
      const state = metadata.workspace;
      const project = metadata.project;
      const inputContainer = document.getElementById("input-container-wrapper");
      const previewContainerWrapper = document.getElementById("preview-container-wrapper");
      inputContainer!.style.width = `${state.layout.inputContainerWidthPct}%`;
      if (previewContainerWrapper) previewContainerWrapper.style.width = `${100 - state.layout.inputContainerWidthPct}%`;
      this.sidebarVisible = state.layout.sidebarVisible;
      const pinnedMainFilePath = await this.absoluteWorkspacePath(workspacePath, project.mainFile);
      this.pinnedMainFilePath = pinnedMainFilePath
        && await invoke<boolean>("workspace_path_exists", { path: pinnedMainFilePath })
        ? pinnedMainFilePath
        : null;
      if (project.mainFile && !this.pinnedMainFilePath) metadata.project.mainFile = null;
      const explorerSidebar = document.getElementById("explorer-sidebar");
      if (explorerSidebar) explorerSidebar.style.width = `${state.layout.explorerSidebarWidthPx}px`;

      const restoredTabs = await Promise.all(state.openTabs.map(async tabInfo => ({
        tabInfo,
        path: await this.absoluteWorkspacePath(workspacePath, tabInfo.path)
      })));
      for (const { tabInfo, path } of restoredTabs) {
        if (!path) continue;
        try {
          const contents = (isBinaryImagePath(path) || fileExtension(path) === "pdf")
            ? await invoke<string>("read_workspace_file_as_base64", { path })
            : normalizeEditorText(await invoke<string>("read_workspace_file", { path }));
          this.openTabs.push({
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
            previewDisabled: false,
            version: 1,
            latestVersion: 1,
            selectionAnchor: tabInfo.selectionAnchor || 0,
            selectionHead: tabInfo.selectionHead || 0,
            scrollTop: tabInfo.scrollTop,
            scrollLeft: tabInfo.scrollLeft,
            foldRanges: Array.isArray(tabInfo.foldRanges) ? this.normalizeFoldRanges(tabInfo.foldRanges, contents.length) : null
          });
        } catch (e) {
          console.warn("Failed to restore tab:", path, e);
        }
      }
      this.renderEditorTabs();

      if (this.openTabs.length === 0) {
        for (const candidate of workspaceRestoreCandidates(metadata)) {
          const path = await this.absoluteWorkspacePath(workspacePath, candidate);
          if (path && await invoke<boolean>("workspace_path_exists", { path })) {
            await this.loadFile(path, { skipPreviewActivation: true });
            return;
          }
        }
      }

      const activeFilePath = await this.absoluteWorkspacePath(workspacePath, state.activeFile);
      if (activeFilePath) {
        const activeTab = this.openTabs.find(tab => filePathKey(tab.path) === filePathKey(activeFilePath));
        if (activeTab) await this.activateEditorTab(activeTab.path, false, { skipPreviewActivation: true });
        else if (this.openTabs.length > 0) await this.activateEditorTab(this.openTabs[0].path, false, { skipPreviewActivation: true });
      } else if (this.openTabs.length > 0) {
        await this.activateEditorTab(this.openTabs[0].path, false, { skipPreviewActivation: true });
      }
    } catch (e) {
      console.warn("Failed to restore workspace state:", e);
      throw e;
    }
  }

  private async handleWorkspaceChange(change: WorkspaceChange): Promise<void> {
    const workspaceRoot = this.workspaceRootPath;
    if (!workspaceRoot || filePathKey(change.rootPath) !== filePathKey(workspaceRoot)) return;

    // Ignore changes that are only inside the cache (.typsastra) directory to prevent infinite loops and race conditions
    const externalPaths = change.paths.filter(path => {
      const relPath = path.startsWith(workspaceRoot)
        ? path.substring(workspaceRoot.length)
        : path;
      const cleanRel = relPath.replace(/^[/\\]+/, "").replace(/\\/g, "/");
      return !cleanRel.startsWith(".typsastra");
    });
    
    if (externalPaths.length === 0) return;

    const openPathKeysBeforeReload = new Set(this.openTabs.map(tab => filePathKey(tab.path)));

    // One ordered synchronization path: editor state, render mirror, LSP, preview.
    const openFilesChanged = await this.reloadOpenFilesFromDisk(false);
    if (this.workspaceRootPath !== workspaceRoot) return;
    // The workspace watcher also observes Typsastra's own saves. When every
    // reported source path is already open and its disk contents still match
    // the saved editor revision, there is no external change to propagate.
    // Avoid rebuilding the mirror and invalidating Tinymist a second time.
    if (
      !openFilesChanged
      && externalPaths.every(path => openPathKeysBeforeReload.has(filePathKey(path)))
    ) {
      this.appendDeveloperLog({
        kind: "info",
        source: "memory diagnostics",
        message: "Workspace watcher self-save event suppressed; mirror preparation and duplicate Tinymist invalidation skipped."
      });
      await this.logMemoryDiagnostics("workspace watcher: self-save suppressed");
      return;
    }
    await this.prepareRenderProjectIfNeeded();

    if (this.lspReady && this.lspClient) {
      const defaultType: 1 | 2 | 3 = change.kind === "create" ? 1 : change.kind === "remove" ? 3 : 2;
      const lastPathIndex = externalPaths.length - 1;
      const changes = externalPaths.map((path, index) => {
        return {
          uri: filePathToUri(path),
          type: change.kind === "rename" && change.paths.length > 1
            ? (index === lastPathIndex ? 1 : 3) as 1 | 3
            : defaultType
        };
      });
      await this.lspClient.notifyWorkspaceFilesChanged(changes);
    }
    await this.explorer.loadWorkspace(workspaceRoot);
    if (this.workspaceRootPath !== workspaceRoot) return;
    await this.refreshActivePreviewRoot();
  }

  private publishPerformanceMetric(metric: PerformanceMetric): void {
    if (!this.isDeveloperLogEnabled("performance")) return;
    const value = metric.milliseconds !== undefined
      ? `${metric.milliseconds.toFixed(1)} ms`
      : metric.bytes !== undefined
        ? `${(metric.bytes / 1024 / 1024).toFixed(1)} MiB`
        : "recorded";
    console.info(`[performance] ${metric.name}: ${value}`, metric.detail ?? {});
    this.appendDeveloperLog({
      kind: "info",
      source: "performance",
      message: `${metric.name}: ${value}${metric.detail ? ` (${JSON.stringify(metric.detail)})` : ""}`
    });
    if (metric.name.startsWith("preview.") && metric.milliseconds !== undefined) {
      const count = (this.performanceSummaryCounts.get(metric.name) ?? 0) + 1;
      this.performanceSummaryCounts.set(metric.name, count);
      if (count % 20 === 0) {
        const summary = this.performanceDiagnostics.summary(metric.name);
        if (summary) {
          this.appendDeveloperLog({
            kind: "info",
            source: "performance",
            message: `${metric.name} rolling summary: n=${summary.samples}; p50=${summary.p50.toFixed(1)} ms; p95=${summary.p95.toFixed(1)} ms; max=${summary.maximum.toFixed(1)} ms`
          });
        }
      }
    }
  }

  private async logMemoryDiagnostics(
    stage: string,
    detail: Record<string, number | string | boolean> = {}
  ): Promise<void> {
    if (!this.isDeveloperLogEnabled("memory")) return;
    const sequence = ++this.memoryDiagnosticSequence;
    const heap = (performance as Performance & {
      memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
    }).memory;
    const processes = await invoke<ProcessMemorySample[]>("get_memory_diagnostics").catch(error => {
      this.appendDeveloperLog({
        kind: "warning",
        source: "memory diagnostics",
        message: `Memory sample ${sequence} native process query failed: ${String(error)}`
      });
      return [];
    });
    const categoryBytes = (predicate: (name: string) => boolean) => processes
      .filter(process => predicate(process.name.toLocaleLowerCase()))
      .reduce((total, process) => total + process.workingSetBytes, 0);
    const webviewBytes = categoryBytes(name => name.includes("msedgewebview2") || name.includes("webkit"));
    const tinymistBytes = categoryBytes(name => name.includes("tinymist"));
    const relatedBytes = processes.reduce((total, process) => total + process.workingSetBytes, 0);
    const backendBytes = Math.max(0, relatedBytes - webviewBytes - tinymistBytes);
    const totals: MemoryDiagnosticTotals = {
      jsHeapBytes: heap?.usedJSHeapSize ?? 0,
      relatedBytes,
      webviewBytes,
      tinymistBytes,
      backendBytes
    };
    const previous = this.previousMemoryDiagnostic;
    this.previousMemoryDiagnostic = totals;
    const preview = this.previewFrame.memorySnapshot();
    const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    const delta = (value: number, before: number | undefined) => before === undefined
      ? "n/a"
      : `${value - before >= 0 ? "+" : ""}${mib(value - before)} MiB`;
    const processSummary = processes
      .map(process => `${process.name}[${process.pid}]=${mib(process.workingSetBytes)} MiB`)
      .join(", ");
    const openDocumentChars = this.openTabs.reduce((total, tab) => total + tab.content.length, 0);
    const detailSummary = Object.entries(detail)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    this.appendDeveloperLog({
      kind: "info",
      source: "memory diagnostics",
      message: [
        `Memory sample ${sequence} (${stage})`,
        `related=${mib(relatedBytes)} MiB (${delta(relatedBytes, previous?.relatedBytes)})`,
        `webview=${mib(webviewBytes)} MiB (${delta(webviewBytes, previous?.webviewBytes)})`,
        `tinymist=${mib(tinymistBytes)} MiB (${delta(tinymistBytes, previous?.tinymistBytes)})`,
        `backend=${mib(backendBytes)} MiB (${delta(backendBytes, previous?.backendBytes)})`,
        `jsHeap=${heap?.usedJSHeapSize === undefined ? "unavailable" : `${mib(heap.usedJSHeapSize)} MiB (${delta(heap.usedJSHeapSize, previous?.jsHeapBytes)})`}`,
        `jsHeapTotal=${heap?.totalJSHeapSize === undefined ? "unavailable" : `${mib(heap.totalJSHeapSize)} MiB`}`,
        `pdf=${mib(preview.pdfBytes)} MiB/${preview.pdfPages} pages/gen ${preview.pdfGeneration}`,
        `finalCanvas=${preview.residentFinalCanvases}; mountedCanvas=${preview.residentCanvases} (${mib(preview.canvasPixels * 4)} MiB estimated RGBA)`,
        `fontFaces=${preview.fontFaces}`,
        `activeRenders=${preview.activeRenders}; pdfLoading=${preview.loading}`,
        `lastPdfBase64=${mib(this.lastPdfBase64.length * 2)} MiB estimated UTF-16`,
        `openTabs=${this.openTabs.length}; openDocumentUtf16=${openDocumentChars}; undoDepth=${undoDepth(this.editorInstance.state)}`,
        detailSummary ? `detail: ${detailSummary}` : "",
        `processes: ${processSummary || "unavailable"}`
      ].filter(Boolean).join("; ")
    });
  }

  private async reloadOpenFilesFromDisk(refreshPreview = true): Promise<boolean> {
    let changed = false;
    for (const tab of [...this.openTabs]) {
      const pathKey = filePathKey(tab.path);
      const exists = await invoke<boolean>("workspace_path_exists", { path: tab.path });
      if (!exists) {
        if (tab.isDirty) {
          this.reportExternalConflict(tab.path, "was removed outside Typsastra");
        } else {
          this.externalConflictPaths.delete(pathKey);
          await this.closeEditorTab(tab.path, true);
        }
        changed = true;
        continue;
      }

      // Unsupported files are represented by a lightweight editor placeholder
      // and are never decoded or synchronized as text.
      if (!isSupportedInAppPath(tab.path)) continue;

      let contents: string;
      try {
        contents = (isBinaryImagePath(tab.path) || fileExtension(tab.path) === "pdf")
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
        changed = true;
        continue;
      }
      if (tab.isDirty) {
        this.reportExternalConflict(tab.path, "changed outside Typsastra");
        changed = true;
        continue;
      }

      this.externalConflictPaths.delete(pathKey);
      await this.applyExternalFileContent(tab, contents, refreshPreview);
      changed = true;
    }
    return changed;
  }

  private async applyExternalFileContent(tab: EditorTab, contents: string, refreshPreview = true): Promise<void> {
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

    if (fileExtension(tab.path) === "pdf") {
      if (refreshPreview) {
        void this.previewFrame.loadPdfData(contents, tab.path);
      }
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
    let lspUpdated = false;
    if (this.lspReady && this.lspClient) {
      const lspRes = await this.getLspUriAndContent(tab.path, contents);
      if (lspRes) {
        const { uri: lspUri, content: lspContent } = lspRes;
        await this.openDocumentIfNeeded(lspUri, lspContent, version);
        await this.lspClient.notifyTextChange(lspUri, lspContent, version);
        await this.lspClient.notifyTextSave(lspUri, lspContent);
        lspUpdated = true;
      }
    }
    if (refreshPreview && tab.path.toLowerCase().endsWith(".typ") && !tab.previewDisabled) {
      if (this.settingsController.value.preview.renderMode === "on-save") {
        void this.renderPdfPreview(contents);
      } else {
        this.schedulePdfPreview(contents);
      }
    }
    this.setLspStatus({
      kind: lspUpdated ? "preview-ready" : "sync-pending",
      message: lspUpdated ? "Reloaded external file change" : "Reloaded external file; preview update queued"
    });
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
      `<div class="preview-disabled-msg" style="margin-top: 8px; font-size: 12px; opacity: 0.75;">Include this file from the configured main document to preview it.</div>` +
      `</div>`
    );
  }

  private renderNonTextEditorPlaceholder(path: string, unsupported: boolean): void {
    const info = document.getElementById("image-viewer-info");
    if (!info) return;

    const placeholder = document.createElement("div");
    placeholder.className = "preview-disabled-placeholder editor-file-placeholder";

    const isPdf = fileExtension(path) === "pdf";

    const icon = document.createElement("div");
    icon.className = "preview-disabled-icon";
    icon.textContent = isPdf ? "\u{1F4C4}" : (unsupported ? "\u{1F4C4}" : "\u{1F4BE}");

    const title = document.createElement("div");
    title.className = "preview-disabled-title";
    title.textContent = isPdf ? "PDF Document" : (unsupported ? "Unsupported File" : "Binary File");

    const fileName = document.createElement("div");
    fileName.className = "editor-file-placeholder-name";
    fileName.textContent = fileNameFromPath(path);

    const description = document.createElement("div");
    description.className = "preview-disabled-msg";
    description.textContent = isPdf
      ? "This document is displayed in the live preview pane."
      : unsupported
        ? "This file format cannot be displayed in Typsastra."
        : "Cannot load raw binary in the text editor.";

    placeholder.append(icon, title, fileName, description);
    if (unsupported || isPdf) {
      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "editor-file-placeholder-action";
      openButton.textContent = "Open Externally";
      openButton.addEventListener("click", () => {
        void this.openFileExternally(path, openButton);
      });
      placeholder.appendChild(openButton);
    }
    info.replaceChildren(placeholder);
  }

  private async openFileExternally(path: string, button?: HTMLButtonElement): Promise<void> {
    if (button) button.disabled = true;
    try {
      await invoke("open_file_externally", { path });
    } catch (error) {
      console.error("Failed to open file externally:", error);
      await message(`The file could not be opened externally.\n\n${String(error)}`, {
        title: "Open External File Failed",
        kind: "error"
      });
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }

  private renderInteractiveImageViewer(src: string) {
    this.updatePreviewActionsToolbar(this.activeFilePath);

    this.previewFrame.setMessage(
      `<div id="interactive-image-container" style="position:relative;width:100%;height:100%;background:var(--ui-bg);overflow:hidden;display:flex;align-items:center;justify-content:center;user-select:none;box-sizing:border-box;">` +
      `<img id="interactive-image-el" alt="Image preview" draggable="false" style="max-width:none;max-height:none;position:absolute;cursor:grab;user-select:none;will-change:transform;visibility:hidden;" />` +
      `</div>`
    );

    const container = document.getElementById("interactive-image-container");
    const img = document.getElementById("interactive-image-el") as HTMLImageElement | null;

    if (!container || !img) return;

    let scale = 1;
    let x = 0;
    let y = 0;
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let isFit = true;

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

    const zoomInImg = () => {
      const zoomFactor = 1.2;
      scale = Math.min(scale * zoomFactor, 20);
      isFit = false;
      updateTransform();
      this.updatePreviewZoomLabel(scale);
    };

    const zoomOutImg = () => {
      const zoomFactor = 1.2;
      scale = Math.max(scale / zoomFactor, 0.05);
      isFit = false;
      updateTransform();
      this.updatePreviewZoomLabel(scale);
    };

    const zoomToFitImg = () => {
      resetToFit();
      isFit = true;
      this.updatePreviewZoomLabel(scale);
    };

    this.imageZoomIn = zoomInImg;
    this.imageZoomOut = zoomOutImg;
    this.imageZoomToFit = zoomToFitImg;
    this.imageZoomPercent = () => scale;
    this.imageIsFit = () => isFit;

    img.onload = () => {
      requestAnimationFrame(() => {
        resetToFit();
        isFit = true;
        this.updatePreviewZoomLabel(scale);
      });
    };
    img.onerror = () => this.previewFrame.setError(
      "Image preview unavailable",
      "Typsastra could not decode this image."
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
      isFit = false;
      updateTransform();
      this.updatePreviewZoomLabel(scale);
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
  }

  private async refreshActivePreviewRoot(forceRender = false): Promise<void> {
    if (!this.activeFilePath) return;
    const path = this.activeFilePath;
    const ext = fileExtension(path);
    const unsupportedFile = !isSupportedInAppPath(path);
    const isPdf = ext === "pdf";

    this.imageZoomIn = null;
    this.imageZoomOut = null;
    this.imageZoomToFit = null;
    this.imageZoomPercent = null;
    this.imageIsFit = null;

    this.updatePreviewActionsToolbar(path);

    if (unsupportedFile || isBinaryImagePath(path) || isPdf) {
      const tab = this.getActiveTab();
      if (!tab) return;
      if (isBinaryImagePath(path)) {
        this.renderInteractiveImageViewer(tab.content);
      } else if (isPdf) {
        void this.previewFrame.loadPdfData(tab.content, path);
      } else {
        this.previewFrame.setMessage(
          `<div class="preview-disabled-placeholder">` +
          `<div class="preview-disabled-title">Preview Unavailable</div>` +
          `<div class="preview-disabled-msg">Open this file with its system application to view it.</div>` +
          `</div>`
        );
      }
      return;
    }

    if (ext === "svg") {
      this.previewFrame.setMessage(
        `<div style="display:flex;align-items:center;justify-content:center;height:100%;width:100%;background:var(--ui-bg);box-sizing:border-box;padding:20px;overflow:auto;">` +
        this.editorInstance.state.doc.toString() +
        `</div>`
      );
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
    await this.updatePinnedMain(previewLspMainPath(target));
    const docIdentity = target.rootPath
      ? researchDocumentIdentity(
          this.workspaceRootPath ?? target.rootPath,
          target.mainPath,
          this.activeFilePath
        )
      : null;
    const identity = target.rootPath
      ? previewSessionIdentity(
          target.rootPath,
          previewRefreshStyle(this.settingsController.value.preview.renderMode),
          docIdentity ?? undefined
        )
      : null;
    const unchanged = identity?.key === this.previewSessionKey;
    if (unchanged && !forceRender) return;

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
      const closed = await this.closeProject();
      if (!closed) return;
    }
    this.workspaceLoading = true;
    this.updateWorkspaceViewportVisibility();
    try {
      await invoke("cleanup_workspace_preview_files", { workspaceRootPath: selected });
      this.workspaceRootPath = selected;
      this.lspReady = false;
      this.workspaceMetadata = await this.loadWorkspaceMetadata(selected);
      this.spellcheckController.setTerminology(
        this.settingsController.value.editor.globalTerminology,
        this.workspaceMetadata.project.terminology,
        this.settingsController.value.editor.languageTerminology,
        this.settingsController.value.editor.scopedIgnoredWords,
      );
      this.settingsController.setProjectTerminology(
        this.workspaceMetadata.project.terminology,
        entries => {
          if (!this.workspaceMetadata) return;
          this.workspaceMetadata.project.terminology = entries;
          this.spellcheckController.setTerminology(
            this.settingsController.value.editor.globalTerminology,
            entries,
            this.settingsController.value.editor.languageTerminology,
            this.settingsController.value.editor.scopedIgnoredWords,
          );
          void this.saveWorkspaceState();
        },
      );
      await this.restoreWorkspaceToolchain(this.workspaceMetadata);
      const expandedDirectories = (await Promise.all(
        this.workspaceMetadata.workspace.expandedDirectories.map(path => this.absoluteWorkspacePath(selected, path))
      )).filter((path): path is string => !!path);
      await this.explorer.loadWorkspace(selected, expandedDirectories);
      await this.restoreWorkspaceState(selected, this.workspaceMetadata);
      if (this.activeFilePath) await this.explorer.revealPath(this.activeFilePath);
      await this.saveWorkspaceState();
      await this.explorer.loadWorkspace(selected);
      await this.workspaceWatcher.start(selected);
      this.recentProjectsController.add(selected);
    } catch (error) {
      this.workspaceWatcher.stop();
      this.workspaceRootPath = null;
      this.workspaceMetadata = null;
      this.activeFilePath = null;
      this.pinnedMainFilePath = null;
      this.openTabs = [];
      this.explorer.setActiveFile(null);
      this.renderEditorTabs();
      await message(String(error), { title: "Unable to Open Workspace", kind: "error" });
      return;
    } finally {
      this.workspaceLoading = false;
      this.updateWorkspaceViewportVisibility();
    }
    void this.startWorkspaceServices(selected);
  }

  private async startWorkspaceServices(selected: string): Promise<void> {
    try {
      if (this.workspaceRootPath !== selected) return;
      await this.prepareRenderProjectIfNeeded();
      if (this.workspaceRootPath !== selected) return;
      if (this.lspClient) {
        this.setLspStatus({ kind: "starting", message: "Connecting to new workspace root..." });
        this.lspReady = false;
        this.openedDocumentUris.clear();
        try {
          await this.lspClient.restart();
          if (this.workspaceRootPath !== selected) return;
          this.lspReady = true;
          this.pdfSyncPreviewTaskKey = null;
          this.pdfSyncRegisteredTaskId = null;
          this.pdfSourceMapStartup = null;
          this.pdfSourceMapStartupKey = null;
          this.pdfSyncSocket?.close();
          this.pdfSyncSocket = null;
          this.pdfSyncSocketUrl = "";
        } catch (error) {
          if (this.workspaceRootPath !== selected) return;
          this.lspReady = false;
          this.appendDeveloperLog({
            kind: "error",
            source: "lsp",
            message: `Failed to restart Tinymist for workspace ${selected}: ${String(error)}`
          });
        }
      }
      if (this.workspaceRootPath === selected && this.activeFilePath) {
        await this.refreshActivePreviewRoot(true);
      }
    } catch (error) {
      if (this.workspaceRootPath === selected) {
        this.appendDeveloperLog({
          kind: "error",
          source: "workspace",
          message: `Workspace services failed to start: ${String(error)}`
        });
      }
    }
  }

  private async restoreWorkspaceToolchain(metadata: WorkspaceMetadata): Promise<void> {
    this.recommendedWorkspaceToolchain = metadata.project.recommendedToolchain;
    this.selectedWorkspaceToolchain = metadata.workspace.selectedToolchain;
    if (!this.selectedWorkspaceToolchain) return;
    try {
      const status = await invoke<ToolchainStatus>("select_project_toolchain", {
        tinymistVersion: this.selectedWorkspaceToolchain.tinymistVersion,
        typstVersion: this.selectedWorkspaceToolchain.typstVersion
      });
      this.toolchainController.setStatus(status);
    } catch (error) {
      this.appendDeveloperLog({
        kind: "warning",
        source: "toolchain",
        message: `Could not restore this workspace's selected toolchain: ${String(error)}`
      });
    }
  }

  private async importTypsastraProject(archivePath?: string): Promise<void> {
    const selected = archivePath ?? await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Typsastra Project", extensions: ["typsastra", "typstella"] }]
    });
    if (typeof selected !== "string") return;

    try {
      this.setLspStatus({ kind: "starting", message: "Inspecting Typsastra project..." });
      let inspection = await invoke<TypsastraProjectPreflight>("inspect_typsastra_project", {
        archivePath: selected
      });
      const requiredTinymist = inspection.manifest.toolchain.tinymistVersion;
      const requiredTypst = inspection.manifest.toolchain.typstVersion;
      let allowIncompatibleToolchain = false;

      if (inspection.toolchainState === "exact-installed") {
        const useInstalled = await confirm(
          `This project requires Tinymist ${requiredTinymist} with Typst ${requiredTypst}. ` +
          "The compatible version is installed but not active. Use it for this import?",
          {
            title: "Compatible Toolchain Available",
            kind: "info",
            okLabel: "Use Compatible Version",
            cancelLabel: "Other Options"
          }
        );
        if (useInstalled) {
          const status = await invoke<ToolchainStatus>("select_project_toolchain", {
            tinymistVersion: requiredTinymist,
            typstVersion: requiredTypst
          });
          this.settingsController.update(settings => {
            settings.toolchain.tinymistVersion = requiredTinymist;
          });
          await this.handleToolchainChanged(status);
          inspection = await invoke<TypsastraProjectPreflight>("inspect_typsastra_project", {
            archivePath: selected
          });
        } else {
          allowIncompatibleToolchain = await this.confirmIncompatibleProjectImport(inspection);
          if (!allowIncompatibleToolchain) return;
        }
      } else if (inspection.toolchainState === "download-required") {
        const downloadCompatible = await confirm(
          `This project was exported with Tinymist ${requiredTinymist}, which embeds Typst ${requiredTypst}. ` +
          "Download and activate that compatible version before importing?",
          {
            title: "Compatible Toolchain Required",
            kind: "info",
            okLabel: "Download Compatible Version",
            cancelLabel: "Other Options"
          }
        );
        if (downloadCompatible) {
          try {
            this.setLspStatus({
              kind: "starting",
              message: `Downloading Tinymist ${requiredTinymist} for imported project...`
            });
            const status = await invoke<ToolchainStatus>("install_tinymist_toolchain", {
              version: requiredTinymist
            });
            const exact = status.tinymistVersion === requiredTinymist
              && status.typstVersion === requiredTypst;
            await this.handleToolchainChanged(status);
            if (!exact) {
              inspection = {
                ...inspection,
                activeTinymistVersion: status.tinymistVersion,
                activeTypstVersion: status.typstVersion
              };
              const useMismatch = await confirm(
                `Downloaded Tinymist ${status.tinymistVersion ?? "unknown"} reports Typst ` +
                `${status.typstVersion ?? "unknown"}, but the project requires Typst ${requiredTypst}.\n\n` +
                "Import with this incompatible version anyway?",
                {
                  title: "Downloaded Toolchain Is Incompatible",
                  kind: "warning",
                  okLabel: "Import Anyway",
                  cancelLabel: "Cancel"
                }
              );
              if (!useMismatch) return;
              allowIncompatibleToolchain = true;
            } else {
              this.settingsController.update(settings => {
                settings.toolchain.tinymistVersion = requiredTinymist;
              });
              inspection = await invoke<TypsastraProjectPreflight>("inspect_typsastra_project", {
                archivePath: selected
              });
            }
          } catch (downloadError) {
            const recovered = await invoke<ToolchainStatus>("get_toolchain_status").catch(() => null);
            if (recovered) {
              await this.handleToolchainChanged(recovered);
              inspection = {
                ...inspection,
                activeTinymistVersion: recovered.tinymistVersion,
                activeTypstVersion: recovered.typstVersion
              };
            }
            const importAfterFailure = await confirm(
              `The compatible toolchain could not be downloaded or verified.\n\n${String(downloadError)}\n\n` +
              "Import with the current environment without a compatibility guarantee?",
              {
                title: "Compatible Toolchain Unavailable",
                kind: "warning",
                okLabel: "Import Anyway",
                cancelLabel: "Cancel"
              }
            );
            if (!importAfterFailure) return;
            allowIncompatibleToolchain = true;
          }
        } else {
          allowIncompatibleToolchain = await this.confirmIncompatibleProjectImport(inspection);
          if (!allowIncompatibleToolchain) return;
        }
      }

      if (!allowIncompatibleToolchain && inspection.toolchainState !== "exact-active") {
        throw new Error("The required project toolchain could not be activated.");
      }
      const destinationParent = await open({
        directory: true,
        multiple: false,
        title: "Choose where to import the project"
      });
      if (typeof destinationParent !== "string") return;
      const destinationPath = await join(destinationParent, inspection.suggestedFolderName);
      const sizeMiB = (inspection.totalUncompressedBytes / 1024 / 1024).toFixed(1);
      const confirmed = await confirm(
        `Import “${inspection.manifest.project.name}” to:\n${destinationPath}\n\n` +
        `${inspection.entryCount} archive entries, ${sizeMiB} MiB uncompressed.` +
        "\n\nFonts are not included. Install the fonts required by this project separately.",
        {
          title: "Import Typsastra Project",
          kind: "info",
          okLabel: "Import Project",
          cancelLabel: "Cancel"
        }
      );
      if (!confirmed) return;

      this.setLspStatus({ kind: "starting", message: "Verifying and importing project..." });
      const imported = await this.runCancellableProjectImport({
        archivePath: selected,
        destinationPath,
        expectedManifestSha256: inspection.manifestSha256,
        allowIncompatibleToolchain
      });
      await this.openWorkspace(imported.workspacePath);
      const activeToolchain = await invoke<ToolchainStatus>("get_toolchain_status").catch(() => null);
      this.recommendedWorkspaceToolchain = {
        tinymistVersion: imported.manifest.toolchain.tinymistVersion,
        typstVersion: imported.manifest.toolchain.typstVersion
      };
      this.selectedWorkspaceToolchain = activeToolchain?.tinymistVersion && activeToolchain.typstVersion
        ? { tinymistVersion: activeToolchain.tinymistVersion, typstVersion: activeToolchain.typstVersion }
        : null;
      if (this.workspaceRootPath && filePathKey(this.workspaceRootPath) === filePathKey(imported.workspacePath)) {
        await this.setPinnedMainFile(imported.mainFilePath);
        await this.saveWorkspaceState();
        this.setLspStatus({ kind: "preview-ready", message: `Imported ${imported.manifest.project.name}` });
      } else {
        await message(`The project was imported to:\n\n${imported.workspacePath}`, {
          title: "Project Imported",
          kind: "info"
        });
      }
    } catch (error) {
      this.setLspStatus({ kind: "error", message: `Project import failed: ${error}` });
      await message(String(error), { title: "Typsastra Project Import Failed", kind: "error" });
    }
  }

  private async runCancellableProjectImport(args: {
    archivePath: string;
    destinationPath: string;
    expectedManifestSha256: string;
    allowIncompatibleToolchain: boolean;
  }): Promise<ImportedTypsastraProject> {
    const operationId = crypto.randomUUID();
    const progress = document.createElement("div");
    progress.setAttribute("role", "status");
    progress.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:10000;display:flex;gap:12px;align-items:center;padding:12px 14px;border:1px solid var(--ui-hover);border-radius:8px;background:var(--ui-bg);color:var(--ui-text);box-shadow:0 8px 24px rgba(0,0,0,.3)";
    const label = document.createElement("span");
    label.textContent = "Verifying and extracting Typsastra project…";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      cancel.disabled = true;
      label.textContent = "Cancelling import safely…";
      void invoke("cancel_typsastra_project_import", { operationId });
    });
    progress.append(label, cancel);
    document.body.appendChild(progress);
    try {
      return await invoke<ImportedTypsastraProject>("import_typsastra_project", {
        ...args,
        operationId
      });
    } finally {
      progress.remove();
    }
  }

  private async confirmIncompatibleProjectImport(
    inspection: TypsastraProjectPreflight
  ): Promise<boolean> {
    const active = inspection.activeTinymistVersion && inspection.activeTypstVersion
      ? `Current: Tinymist ${inspection.activeTinymistVersion}, Typst ${inspection.activeTypstVersion}.`
      : "No validated toolchain is currently active.";
    return confirm(
      `The project requires Tinymist ${inspection.manifest.toolchain.tinymistVersion} with ` +
      `Typst ${inspection.manifest.toolchain.typstVersion}. ${active}\n\n` +
      "Importing with the current environment is allowed, but rendering compatibility is not guaranteed.",
      {
        title: "Import Without Compatibility Guarantee?",
        kind: "warning",
        okLabel: "Import Anyway",
        cancelLabel: "Cancel"
      }
    );
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
      await this.closeProject({ confirmUnsaved: false });
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
    const mainWasAlreadyActive = path !== null
      && this.activeFilePath !== null
      && filePathKey(path) === filePathKey(this.activeFilePath);
    this.pinnedMainFilePath = path;
    this.saveWorkspaceState();
    
    if (path) {
      await this.loadFile(path, { temporary: false });
      this.sortPinnedMainTabFirst();
    } else {
      await this.updatePinnedMain(null);
    }
    
    this.renderEditorTabs();
    
    if (this.workspaceRootPath) {
      await this.explorer.loadWorkspace(this.workspaceRootPath);
    }
    
    await this.refreshActivePreviewRoot(mainWasAlreadyActive);
  }

  private async closeProject(options: { confirmUnsaved?: boolean } = {}): Promise<boolean> {
    const confirmUnsaved = options.confirmUnsaved ?? true;
    if (confirmUnsaved && this.openTabs.some(tab => tab.isDirty)) {
      const shouldClose = await confirm(
        "Close this project with unsaved changes? The editor state will be kept for workspace recovery, but the files are not saved to disk.",
        { title: "Unsaved Changes", kind: "warning" }
      );
      if (!shouldClose) return false;
    }

    await this.saveWorkspaceState();
    this.workspaceWatcher.stop();

    const previewTaskIds = new Set([
      this.previewTaskId,
      this.pdfPreviewSourceMapTaskId,
      this.pdfSyncRegisteredTaskId
    ].filter((taskId): taskId is string => Boolean(taskId)));
    if (this.lspClient) {
      for (const taskId of previewTaskIds) {
        void this.lspClient.stopPreview(taskId).catch(() => {});
      }
    }

    if (this.pdfPreviewTimer !== null) window.clearTimeout(this.pdfPreviewTimer);
    if (this.typographyScaleCheckTimer !== null) window.clearTimeout(this.typographyScaleCheckTimer);
    this.pdfPreviewTimer = null;
    this.typographyScaleCheckTimer = null;
    this.typographyScaleCheckGeneration += 1;
    this.acceptedTypographyScales.clear();
    this.pdfPreviewGeneration += 1;
    this.pdfForwardSyncGeneration += 1;
    this.queuedPdfPreviewContents = null;
    this.queuedPdfPreviewForced = false;
    this.pendingPdfForwardSync = null;
    this.manualForwardSyncGeneration = null;
    this.queuedManualForwardSync = null;

    this.workspaceRootPath = null;
    this.workspaceMetadata = null;
    this.workspaceLoading = false;
    this.recommendedWorkspaceToolchain = null;
    this.selectedWorkspaceToolchain = null;
    this.activeFilePath = null;
    this.explorer.setActiveFile(null);
    this.openTabs = [];
    this.pinnedMainFilePath = null;
    this.pinnedLspMainPath = null;
    this.previewRootPath = null;
    this.previewMainPath = null;
    this.previewTaskId = null;
    this.previewSessionKey = null;
    this.previewImported = false;
    this.previewStandalone = true;
    this.previewDisabled = false;
    this.pdfPreviewSourceMapRootPath = null;
    this.pdfPreviewSourceMapTaskId = null;
    this.pdfPreviewGeneratedFiles.clear();
    this.pdfSyncPreviewTaskKey = null;
    this.pdfSyncRegisteredTaskId = null;
    this.pdfSourceMapStartup = null;
    this.pdfSourceMapStartupKey = null;
    this.pdfSyncSocket?.close();
    this.pdfSyncSocket = null;
    this.pdfSyncSocketUrl = "";
    this.lastPdfBase64 = "";
    this.imageZoomIn = null;
    this.imageZoomOut = null;
    this.imageZoomToFit = null;
    this.imageZoomPercent = null;
    this.imageIsFit = null;
    this.updatePreviewActionsToolbar(null);

    this.openedDocumentUris.clear();
    this.preparedPreviewDocumentVersions.clear();
    this.externalConflictPaths.clear();
    this.clearPendingLspSync();
    this.previewSyncController.clearForward();
    this.clearDiagnostics();

    this.isLoadingFile = true;
    try {
      this.editorInstance.dispatch({
        changes: { from: 0, to: this.editorInstance.state.doc.length, insert: "" }
      });
      this.applyFoldRanges([]);
    } finally {
      this.isLoadingFile = false;
    }
    this.activateSpellcheckDocument(null);
    this.editorFontManager.updateDocument("");
    this.editorToolbarController.setDisabled(true);
    if (this.activeMode === "WYSIWYM") this.mapMarkupToWysiwym("");
    
    // Clear workspace navigation
    document.getElementById("workspace-explorer-tree")!.innerHTML = "";
    this.documentOutlineController.clear();
    this.previewFrame.clear();
    this.renderEditorTabs();
    this.setLspStatus({ kind: "ready", message: "Project closed" });
    this.updateWorkspaceViewportVisibility();
    return true;
  }

  private bindGlobalEvents() {
    installModalFocusTrap();
    const refreshInputLanguage = (force = false) => {
      const generation = this.inputLanguageService.currentGeneration();
      const startedAt = performance.now();
      void this.inputLanguageService.refresh(force).then(() => {
        this.performanceDiagnostics.record({
          name: "language.inputSource",
          milliseconds: performance.now() - startedAt,
          detail: { changed: generation !== this.inputLanguageService.currentGeneration() },
        });
        if (generation !== this.inputLanguageService.currentGeneration() && this.editorInstance) {
          closeCompletion(this.editorInstance);
        }
      }).catch(error => console.warn("Input language detection failed:", error));
    };
    window.addEventListener("focus", () => refreshInputLanguage(true));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshInputLanguage(true);
    });
    import("@tauri-apps/api/event").then(({ listen, emit }) => {
      listen("preview-window-ready", () => {
        if (this.lastPdfBase64) {
          emit("pdf-update", this.lastPdfBase64);
        }
      });
      listen<PreviewClickPoint>("pdf-click", (event) => {
        const point = event.payload;
        void this.handlePdfPreviewClick(point);
      });
    }).catch(err => console.error("Error setting up Tauri preview event listeners", err));

    void listen("typsastra-project-open-requested", () => {
      void this.drainPendingProjectImports();
    });

    window.addEventListener("beforeunload", () => {
      if (this.pdfSyncRegisteredTaskId && this.lspClient) {
        void this.lspClient.stopPreview(this.pdfSyncRegisteredTaskId).catch(() => {});
      }
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
      refreshInputLanguage();
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

      if (e.altKey && !cmdOrCtrl && !e.shiftKey && keyCode === "Enter") {
        e.preventDefault();
        this.revealCursorInPreviewManually();
        return;
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

      const recentProjectIndex = recentProjectShortcutIndex(e);
      const welcomeScreen = document.getElementById("welcome-screen");
      if (
        recentProjectIndex !== null
        && welcomeScreen
        && !welcomeScreen.classList.contains("hidden")
        && this.recentProjectsController.openAt(recentProjectIndex)
      ) {
        e.preventDefault();
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
      this.zoomOut();
    });

    document.getElementById("preview-zoom-in-btn")?.addEventListener("click", () => {
      this.zoomIn();
    });

    document.getElementById("preview-zoom-fit-btn")?.addEventListener("click", () => {
      this.zoomToFit();
    });

    document.getElementById("preview-recompile-btn")?.addEventListener("click", () => {
      this.recompilePreviewManually();
    });

    const previewForwardSyncButton = document.getElementById("preview-forward-sync-btn");
    previewForwardSyncButton?.addEventListener("pointerdown", event => {
      if (event.button === 0 && this.editorInstance.hasFocus) event.preventDefault();
    });
    previewForwardSyncButton?.addEventListener("click", () => {
      this.revealCursorInPreviewManually();
    });

    this.updatePreviewZoomLabel();
    this.updateManualForwardSyncAction();

    document.getElementById("action-open-folder")?.addEventListener("click", async () => {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        await this.openWorkspace(selected);
      }
    });

    document.getElementById("action-import-project")?.addEventListener("click", async () => {
      await this.importTypsastraProject();
    });
    
    document.getElementById("action-restart-workspace")?.addEventListener("click", () => {
      void this.restartWorkspace();
    });

    document.getElementById("action-close-project")?.addEventListener("click", () => {
      void this.closeProject();
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
          const rootPath = this.previewStandalone
            ? (this.previewRootPath ?? this.activeFilePath)
            : (this.previewMainPath ?? this.previewRootPath ?? this.activeFilePath);
          
          if (!rootPath) throw new Error("No export root path available");

          let targetFilePath = rootPath;
          let targetContent = "";
          if (filePathKey(targetFilePath) === filePathKey(this.activeFilePath)) {
            targetContent = content;
          } else {
            targetContent = await invoke<string>("read_workspace_file", { path: targetFilePath }).catch(() => "");
          }

          const cacheRoot = this.getCacheRootPath();
          if (cacheRoot && this.workspaceRootPath) {
            const originalRootPath = this.mapToOriginalPath(rootPath);
            const originalActivePath = this.mapToOriginalPath(this.activeFilePath);
            
            const options = {
              enableKhmerZws: this.settingsController.value.preview.khmerRenderPreparation,
              projectRoot: this.workspaceRootPath,
              entryFile: originalRootPath,
              cacheRoot,
              generateSourceMap: false
            };

            const result = await invoke<{ generatedEntryFile: string }>("prepare_render_project", { options });
            
            const tabsToOverlay = this.openTabs
              .filter(tab => tab.path.toLowerCase().endsWith(".typ"))
              .filter(tab => this.workspaceRootPath && relativeFilePath(this.workspaceRootPath, this.mapToOriginalPath(tab.path)) !== null);
            
            for (const tab of tabsToOverlay) {
              const originalTabPath = this.mapToOriginalPath(tab.path);
              const sourceCode = filePathKey(originalTabPath) === filePathKey(originalActivePath)
                ? content
                : tab.content;
              
              await invoke("prepare_render_file", {
                options,
                filePath: originalTabPath,
                sourceCode
              });
            }

            targetFilePath = result.generatedEntryFile;
            targetContent = await invoke<string>("read_workspace_file", { path: targetFilePath }).catch(() => "");
          }

          const pdfPath = await invoke<string>("compile_typst_document", {
            sourceCode: targetContent,
            filePath: targetFilePath
          });

          const originalPdfPath = (this.previewStandalone
            ? this.activeFilePath
            : (this.previewMainPath ?? this.activeFilePath)).replace(/\.typ$/, ".pdf");
          
          await invoke("copy_workspace_file", { source: pdfPath, dest: originalPdfPath });
          await invoke("move_to_trash", { path: pdfPath });
          
          this.setLspStatus({ kind: "preview-ready", message: `Exported to ${originalPdfPath}` });
        } catch (error) {
          this.setLspStatus({ kind: "error", message: `Export failed: ${error}` });
        }
      }
    });

    document.getElementById("action-export-project")?.addEventListener("click", async () => {
      if (!this.workspaceRootPath) {
        alert("Please open a project workspace first.");
        return;
      }
      if (this.openTabs.some(tab => tab.isDirty)) {
        await message("Save all modified files before exporting so the archive matches the editor.", {
          title: "Unsaved Files",
          kind: "warning"
        });
        return;
      }

      const mainFilePath = this.previewMainPath ?? (
        this.activeFilePath?.toLowerCase().endsWith(".typ") ? this.activeFilePath : null
      );
      if (!mainFilePath) {
        await message("Set or open the project's main Typst file before exporting a version-bound project.", {
          title: "Main File Required",
          kind: "warning"
        });
        return;
      }

      try {
        const folderName = this.workspaceRootPath.split(/[/\\]/).pop() || "workspace";
        const selected = await save({
          filters: [{
            name: "Typsastra Project",
            extensions: ["typsastra"]
          }],
          defaultPath: `${folderName}.typsastra`
        });

        if (selected) {
          this.setLspStatus({ kind: "running", message: "Exporting Typsastra project..." });
          await invoke("export_typsastra_project", {
            workspacePath: this.workspaceRootPath,
            archivePath: selected,
            mainFilePath
          });
          this.setLspStatus({
            kind: "preview-ready",
            message: `Typsastra project exported to ${selected}. Font files were not included.`
          });
        }
      } catch (error) {
        this.setLspStatus({ kind: "error", message: `Project export failed: ${error}` });
        await message(String(error), { title: "Typsastra Project Export Failed", kind: "error" });
      }
    });

    document.getElementById("action-export-source-zip")?.addEventListener("click", async () => {
      if (!this.workspaceRootPath) {
        alert("Please open a project workspace first.");
        return;
      }
      if (this.openTabs.some(tab => tab.isDirty)) {
        await message("Save all modified files before exporting so the ZIP matches the editor.", {
          title: "Unsaved Files",
          kind: "warning"
        });
        return;
      }

      try {
        const folderName = this.workspaceRootPath.split(/[/\\]/).pop() || "workspace";
        const selected = await save({
          filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
          defaultPath: `${folderName}.zip`
        });
        if (selected) {
          this.setLspStatus({ kind: "running", message: "Exporting source ZIP..." });
          await invoke("export_source_zip", {
            workspacePath: this.workspaceRootPath,
            zipPath: selected
          });
          this.setLspStatus({
            kind: "preview-ready",
            message: `Source ZIP exported to ${selected}. Font files were not included.`
          });
        }
      } catch (error) {
        this.setLspStatus({ kind: "error", message: `Source ZIP export failed: ${error}` });
        await message(String(error), { title: "Source ZIP Export Failed", kind: "error" });
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

    document.getElementById("action-fold-file")?.addEventListener("click", () => {
      this.foldCurrentFile();
    });

    document.getElementById("action-unfold-file")?.addEventListener("click", () => {
      this.unfoldCurrentFile();
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

    document.getElementById("action-docs-typsastra")?.addEventListener("click", () => {
      openUrl("https://github.com/sovichea/typsastra");
    });

    document.getElementById("action-docs-typst")?.addEventListener("click", () => {
      openUrl("https://typst.app/docs");
    });

    const aboutOverlay = document.getElementById("about-overlay");
    const aboutClose = document.getElementById("about-close") as HTMLButtonElement | null;
    const aboutAction = document.getElementById("action-about-typsastra") as HTMLElement | null;
    const closeAbout = () => {
      if (aboutOverlay?.classList.contains("hidden")) return;
      aboutOverlay?.classList.add("hidden");
      aboutAction?.focus();
    };
    aboutAction?.addEventListener("click", async () => {
      const version = document.getElementById("about-version");
      if (version) version.textContent = await getVersion().catch(() => "Unavailable");
      aboutOverlay?.classList.remove("hidden");
      aboutClose?.focus();
    });
    aboutClose?.addEventListener("click", closeAbout);
    document.getElementById("about-done")?.addEventListener("click", closeAbout);
    document.getElementById("about-project-page")?.addEventListener("click", () => {
      openUrl("https://github.com/Sovichea/typsastra");
    });
    aboutOverlay?.addEventListener("click", event => {
      if (event.target === aboutOverlay) closeAbout();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !aboutOverlay?.classList.contains("hidden")) closeAbout();
    });

    // TODO: Re-enable the WYSIWYM layout menu action when the implementation is ready.
    // document.getElementById("action-toggle-layout")?.addEventListener("click", () => this.switchViewLayoutMode());
    document.getElementById("action-toggle-logs")?.addEventListener("click", () => this.logConsoleController.toggle());

    // Welcome Screen Actions
    const welcomeScreen = document.getElementById("welcome-screen");
    if (welcomeScreen) installWelcomeKeyboardNavigation(welcomeScreen);
    document.getElementById("welcome-open-project")?.addEventListener("click", () => {
      document.getElementById("action-open-folder")?.click();
    });
    document.getElementById("welcome-import-project")?.addEventListener("click", () => {
      document.getElementById("action-import-project")?.click();
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

    void appWindow.onResized(async () => {
      const maximized = await appWindow.isMaximized();
      updateMaximizeIcon(maximized);
    });
    void appWindow.isMaximized().then(maximized => updateMaximizeIcon(maximized));
    document.getElementById("titlebar-close")?.addEventListener("click", () => appWindow.close());

    void appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      const hasUnsaved = this.openTabs.some(tab => tab.isDirty);
      let proceed = true;
      if (hasUnsaved) {
        proceed = await confirm(
          "You have unsaved changes. Are you sure you want to close Typsastra?",
          { title: "Unsaved Changes", kind: "warning" }
        );
      }
      if (proceed) {
        try {
          const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
          const previewWin = await WebviewWindow.getByLabel("preview");
          if (previewWin) {
            await previewWin.close();
          }
        } catch (e) {
          console.error("Failed to close preview window on exit:", e);
        }
        void appWindow.destroy();
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

  private async drainPendingProjectImports(): Promise<void> {
    const paths = await invoke<string[]>("take_pending_project_imports").catch(error => {
      console.error("Failed to read pending Typsastra project imports:", error);
      return [];
    });
    for (const path of paths) {
      this.projectImportQueue = this.projectImportQueue
        .then(() => this.importTypsastraProject(path))
        .catch(error => console.error("Queued Typsastra project import failed:", error));
    }
    await this.projectImportQueue;
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
    return `${this.workspaceRootPath}/.typsastra/cache`.replace(/\\/g, "/");
  }

  private mapToOriginalPath(cachePath: string): string {
    if (!this.workspaceRootPath) {
      return cachePath;
    }
    const prefix = `${this.workspaceRootPath}/.typsastra/cache/render/`.replace(/\\/g, "/").toLowerCase();
    const cleanCache = cachePath.replace(/\\/g, "/").toLowerCase();
    if (cleanCache.startsWith(prefix)) {
      const relPath = cachePath.substring(prefix.length);
      return `${this.workspaceRootPath}/${relPath}`;
    }
    return cachePath;
  }

  private isRenderCachePath(path: string): boolean {
    if (!this.workspaceRootPath) return false;
    const prefix = `${this.workspaceRootPath}/.typsastra/cache/render/`.replace(/\\/g, "/").toLowerCase();
    return path.replace(/\\/g, "/").toLowerCase().startsWith(prefix);
  }

  private async pdfGeneratedPreviewText(originalPath: string): Promise<string> {
    const key = filePathKey(originalPath);
    const cached = this.pdfPreviewGeneratedFiles.get(key);
    if (cached) return cached.preparedText;
    if (!this.workspaceRootPath) return "";
    const relativePath = relativeFilePath(this.workspaceRootPath, originalPath);
    if (relativePath === null) return "";
    const cacheRoot = this.getCacheRootPath();
    if (!cacheRoot) return "";
    const generatedPath = `${cacheRoot}/render/${relativePath.replace(/\\/g, "/")}`;
    try {
      const preparedText = normalizeEditorText(await invoke<string>("read_workspace_file", { path: generatedPath }));
      this.pdfPreviewGeneratedFiles.set(key, { generatedPath, preparedText });
      return preparedText;
    } catch {
      return "";
    }
  }

  private async getLspUriAndContent(path: string, originalContent: string): Promise<{ uri: string; content: string } | null> {
    return { uri: filePathToUri(path), content: originalContent };
  }

  private getActiveLspUri(): string {
    if (!this.activeFilePath) return "";
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
    if (!this.workspaceRootPath
      || !this.settingsController.value.preview.khmerRenderPreparation
      || this.settingsController.value.preview.renderMode !== "on-type") {
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

function nextAnimationFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function sanitizeLogText(str: string): string {
  return str.replace(/[\x00-\x1F\x7F-\x9F\uFFFD]/g, ".");
}

function parseTinymistPreviewPositions(data: string): PreviewDocumentPosition[] {
  const positions: PreviewDocumentPosition[] = [];
  const jumpPosition = parseTinymistJumpPosition(data);
  if (jumpPosition) positions.push(jumpPosition);

  const candidates = jsonPayloadCandidates(data);
  for (const candidate of candidates) {
    try {
      collectPreviewPositions(JSON.parse(candidate), positions);
    } catch {
      // Keep trying the remaining payload shapes.
    }
  }
  return positions;
}

function parseTinymistJumpPosition(data: string): PreviewDocumentPosition | null {
  const match = data.trim().match(/^jump,\s*(\d+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/u);
  if (!match) return null;
  const pageNo = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!Number.isFinite(pageNo) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { page_no: pageNo, x, y };
}

function jsonPayloadCandidates(data: string): string[] {
  const trimmed = data.trim();
  const candidates = [trimmed];
  const comma = trimmed.indexOf(",");
  if (comma >= 0) candidates.push(trimmed.slice(comma + 1).trim());
  const firstObject = trimmed.indexOf("{");
  if (firstObject >= 0) candidates.push(trimmed.slice(firstObject));
  const firstArray = trimmed.indexOf("[");
  if (firstArray >= 0) candidates.push(trimmed.slice(firstArray));
  return [...new Set(candidates.filter(Boolean))];
}

function collectPreviewPositions(value: unknown, output: PreviewDocumentPosition[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPreviewPositions(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const pageNo = typeof record.page_no === "number"
    ? record.page_no
    : typeof record.page === "number"
      ? record.page
      : undefined;
  if (typeof pageNo === "number" && typeof record.x === "number" && typeof record.y === "number") {
    output.push({ page_no: pageNo, x: record.x, y: record.y });
  }
  for (const item of Object.values(record)) {
    collectPreviewPositions(item, output);
  }
}

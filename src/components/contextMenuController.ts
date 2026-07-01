import { invoke } from "@tauri-apps/api/core";
import { basename, dirname, join } from "@tauri-apps/api/path";
import { confirm } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-shell";
import type { EditorView } from "@codemirror/view";
import { selectAll, toggleLineComment } from "@codemirror/commands";
import type { WorkspaceExplorer } from "./explorer";
import type { SpellingIssue } from "../editor/spellcheck";

export type ContextMenuDependencies = {
  getWorkspaceRoot: () => string | null;
  getActiveFile: () => string | null;
  getEditor: () => EditorView;
  getExplorer: () => WorkspaceExplorer;
  getPreviewFrame: () => HTMLIFrameElement | null;
  loadFile: (path: string) => void | Promise<void>;
  save: () => void | Promise<void>;
  updateTabPath: (oldPath: string, newPath: string) => void;
  activateTab: (path: string) => void | Promise<void>;
  closeTab: (path: string) => void | Promise<void>;
  closeTabInteractive: (path: string) => void | Promise<void>;
  closeOtherTabs: (path: string) => void | Promise<void>;
  restartWorkspace: () => void | Promise<void>;
  getSpellingIssue: (x: number, y: number) => SpellingIssue | null;
  getSpellingSuggestions: (issue: SpellingIssue) => Promise<string[]>;
  replaceSpelling: (issue: SpellingIssue, replacement: string) => void;
};

const previewItems = `
  <div class="dropdown-item" id="ctx-preview-open-external">Open in External Viewer</div>
  <div class="dropdown-separator"></div>
  <div class="dropdown-item" id="ctx-export-pdf">Export PDF</div>`;

export class ContextMenuController {
  private targetPath = "";
  private targetIsDirectory = false;
  private copiedFilePath: string | null = null;
  private textControl: HTMLInputElement | HTMLTextAreaElement | null = null;
  private selectedText = "";
  private contextText = "";
  private readonly menu = document.getElementById("context-menu")!;
  private spellingIssue: SpellingIssue | null = null;
  private spellingSuggestions: string[] = [];

  constructor(private readonly dependencies: ContextMenuDependencies) {}

  public initialize(): void {
    document.addEventListener("click", () => this.hide());
    this.menu.addEventListener("click", event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>(".dropdown-item")?.id;
      if (action) void this.execute(action);
    });
    document.addEventListener("contextmenu", event => void this.showForTarget(event));
    document.getElementById("preview-menu-btn")?.addEventListener("click", event => {
      event.stopPropagation();
      const button = event.currentTarget as HTMLElement;
      const rect = button.getBoundingClientRect();
      this.show(previewItems, rect.right, rect.bottom + 4, true);
    });
    window.addEventListener("message", event => this.handlePreviewMessage(event));
  }

  private async execute(action: string): Promise<void> {
    switch (action) {
      case "ctx-new-file": return this.createFile();
      case "ctx-fs-new-folder": return this.createFolder();
      case "ctx-fs-rename": return this.renameTarget();
      case "ctx-fs-delete": return this.deleteTarget();
      case "ctx-fs-paste": return this.pasteFile();
      case "ctx-open-project": document.getElementById("action-open-folder")?.click(); return;
      case "ctx-export-pdf": document.getElementById("action-export-pdf")?.click(); return;
      case "ctx-copy-text": return this.copyEditorText(false);
      case "ctx-cut-text": return this.copyEditorText(true);
      case "ctx-paste-text": return this.pasteText();
      case "ctx-native-copy": return this.copyNativeText();
      case "ctx-native-cut": return this.cutNativeText();
      case "ctx-native-paste": return this.pasteNativeText();
      case "ctx-native-select-all": this.selectAllNativeText(); return;
      case "ctx-undo": document.getElementById("action-undo")?.click(); return;
      case "ctx-redo": document.getElementById("action-redo")?.click(); return;
      case "ctx-editor-toggle-comment": toggleLineComment(this.dependencies.getEditor()); return;
      case "ctx-editor-select-all": selectAll(this.dependencies.getEditor()); return;
      case "ctx-editor-format": await this.dependencies.save(); return;
      case "ctx-fs-copy":
        if (this.targetIsDirectory) alert("Copying directories directly is not yet supported.");
        else this.copiedFilePath = this.targetPath;
        return;
      case "ctx-fs-reveal": if (this.targetPath) await invoke("reveal_in_explorer", { path: this.targetPath }); return;
      case "ctx-fs-copy-rel-path": return this.copyRelativePath();
      case "ctx-fs-copy-abs-path": if (this.targetPath) await writeText(this.targetPath); return;
      case "ctx-preview-open-external": return this.openPreviewPdf();
      case "ctx-tab-close": if (this.targetPath) await this.dependencies.closeTabInteractive(this.targetPath); return;
      case "ctx-tab-close-others": if (this.targetPath) await this.dependencies.closeOtherTabs(this.targetPath); return;
      case "ctx-restart-workspace": await this.dependencies.restartWorkspace(); return;
      default:
        if (action.startsWith("ctx-spelling-") && this.spellingIssue) {
          const index = Number(action.slice("ctx-spelling-".length));
          const replacement = this.spellingSuggestions[index];
          if (replacement) this.dependencies.replaceSpelling(this.spellingIssue, replacement);
        }
        return;
    }
  }

  private createFile(): Promise<void> {
    const workspace = this.dependencies.getWorkspaceRoot();
    if (!workspace) {
      document.getElementById("action-new-file")?.click();
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.dependencies.getExplorer().showInlineInput(this.targetPath, "file", "", async name => {
        if (name) {
          try {
            const path = await join(await this.parentDirectory(workspace), name);
            await invoke("save_workspace_file", { path, contents: "" });
            await this.refreshExplorer();
            await this.dependencies.loadFile(path);
          } catch (error) { alert(`Failed to create file: ${error}`); }
        }
        resolve();
      });
    });
  }

  private createFolder(): Promise<void> {
    const workspace = this.dependencies.getWorkspaceRoot();
    if (!workspace) return Promise.resolve();
    return new Promise(resolve => {
      this.dependencies.getExplorer().showInlineInput(this.targetPath, "folder", "", async name => {
        if (name) {
          try {
            await invoke("create_workspace_dir", { path: await join(await this.parentDirectory(workspace), name) });
            await this.refreshExplorer();
          } catch (error) { alert(`Failed to create folder: ${error}`); }
        }
        resolve();
      });
    });
  }

  private async renameTarget(): Promise<void> {
    if (!this.targetPath) return;
    const originalPath = this.targetPath;
    const oldName = await basename(originalPath);
    await new Promise<void>(resolve => {
      this.dependencies.getExplorer().showInlineInput(originalPath, "rename", oldName, async newName => {
        if (newName && newName !== oldName) {
          const newPath = await join(await dirname(originalPath), newName);
          try {
            await invoke("rename_workspace_file", { oldPath: originalPath, newPath });
            await this.refreshExplorer();
            const active = this.dependencies.getActiveFile() === originalPath;
            this.dependencies.updateTabPath(originalPath, newPath);
            if (active) await this.dependencies.activateTab(newPath);
          } catch (error) { alert(`Failed to rename: ${error}`); }
        }
        resolve();
      });
    });
  }

  private async deleteTarget(): Promise<void> {
    if (!this.targetPath) return;
    const path = this.targetPath;
    const accepted = await confirm(`Are you sure you want to move this ${this.targetIsDirectory ? "folder" : "file"} to the Trash?`, {
      title: "Confirm Delete", kind: "warning"
    });
    if (!accepted) return;
    try {
      await invoke("move_to_trash", { path });
      await this.refreshExplorer();
      await this.dependencies.closeTab(path);
    } catch (error) { alert(`Failed to move to trash: ${error}`); }
  }

  private async pasteFile(): Promise<void> {
    const workspace = this.dependencies.getWorkspaceRoot();
    if (!workspace || !this.copiedFilePath) return;
    try {
      const destination = await join(await this.parentDirectory(workspace), `Copy of ${await basename(this.copiedFilePath)}`);
      await invoke("copy_workspace_file", { source: this.copiedFilePath, dest: destination });
      await this.refreshExplorer();
    } catch (error) { alert(`Failed to paste file: ${error}`); }
  }

  private async pasteText(): Promise<void> {
    try {
      const editor = this.dependencies.getEditor();
      editor.dispatch(editor.state.replaceSelection(await readText()));
    } catch (error) { console.error("Failed to read clipboard:", error); }
  }

  private async copyEditorText(cut: boolean): Promise<void> {
    const editor = this.dependencies.getEditor();
    const selection = editor.state.selection.main;
    if (selection.empty) return;
    await writeText(editor.state.sliceDoc(selection.from, selection.to));
    if (cut) editor.dispatch(editor.state.replaceSelection(""));
    editor.focus();
  }

  private async copyNativeText(): Promise<void> {
    const text = this.selectedControlText() || this.selectedText || this.contextText;
    if (text) await writeText(text);
  }

  private async cutNativeText(): Promise<void> {
    const control = this.textControl;
    if (!control || control.readOnly || control.disabled) return;
    await this.copyNativeText();
    this.replaceControlSelection("");
  }

  private async pasteNativeText(): Promise<void> {
    const control = this.textControl;
    if (!control || control.readOnly || control.disabled) return;
    try {
      this.replaceControlSelection(await readText());
    } catch (error) {
      console.error("Failed to paste text:", error);
    }
  }

  private selectAllNativeText(): void {
    this.textControl?.select();
  }

  private selectedControlText(): string {
    const control = this.textControl;
    if (!control) return "";
    if (control.selectionStart === null || control.selectionEnd === null) return control.value;
    const start = control.selectionStart;
    const end = control.selectionEnd;
    return control.value.slice(start, end);
  }

  private replaceControlSelection(text: string): void {
    const control = this.textControl;
    if (!control) return;
    if (control.selectionStart === null || control.selectionEnd === null) {
      control.value = text;
      this.dispatchControlInput(control, text);
      return;
    }
    const start = control.selectionStart;
    const end = control.selectionEnd;
    control.setRangeText(text, start, end, "end");
    this.dispatchControlInput(control, text);
  }

  private dispatchControlInput(control: HTMLInputElement | HTMLTextAreaElement, text: string): void {
    control.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: text,
      inputType: text ? "insertFromPaste" : "deleteByCut"
    }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    control.focus();
  }

  private async copyRelativePath(): Promise<void> {
    const workspace = this.dependencies.getWorkspaceRoot();
    if (!workspace || !this.targetPath) return;
    const relative = this.targetPath.replace(workspace, "").replace(/^[\\/]/, "").replace(/\\/g, "/");
    await writeText(relative);
  }

  private async openPreviewPdf(): Promise<void> {
    const activeFile = this.dependencies.getActiveFile();
    if (!activeFile) return;
    const pdf = await join(await dirname(activeFile), (await basename(activeFile)).replace(/\.typ$/i, ".pdf"));
    await open(pdf);
  }

  private async parentDirectory(workspace: string): Promise<string> {
    if (!this.targetPath) return workspace;
    return this.targetIsDirectory ? this.targetPath : dirname(this.targetPath);
  }

  private async refreshExplorer(): Promise<void> {
    const workspace = this.dependencies.getWorkspaceRoot();
    if (workspace) await this.dependencies.getExplorer().loadWorkspace(workspace);
  }

  private async showForTarget(event: MouseEvent): Promise<void> {
    const target = event.target as HTMLElement;
    this.textControl = this.textControlFor(target);
    const selection = window.getSelection();
    this.selectedText = selection?.toString() ?? "";
    const logEntry = target.closest<HTMLElement>(".log-entry");
    this.contextText = logEntry?.querySelector<HTMLElement>(".log-entry-message")?.textContent ?? "";
    if (logEntry && selection?.anchorNode && !logEntry.contains(selection.anchorNode)) this.selectedText = "";
    if (this.textControl) {
      event.preventDefault();
      this.show(this.nativeTextItems(!this.textControl.readOnly && !this.textControl.disabled), event.clientX, event.clientY);
      return;
    }
    if (this.contextText || (this.selectedText && !target.closest(".cm-editor, #code-render-pane"))) {
      event.preventDefault();
      this.show(this.nativeTextItems(false), event.clientX, event.clientY);
      return;
    }
    if (target.closest("#document-outline-section")) {
      this.hide();
      return;
    }
    const explorerItem = target.closest<HTMLElement>(".explorer-item-target");
    this.targetPath = explorerItem?.dataset.path || "";
    this.targetIsDirectory = explorerItem?.dataset.isDir === "true";
    let items: string;
    if (explorerItem) items = this.explorerItems();
    else if (target.closest(".workspace-explorer-section")) {
      this.targetPath = this.dependencies.getWorkspaceRoot() || "";
      this.targetIsDirectory = !!this.targetPath;
      items = this.explorerBackgroundItems();
    } else if (target.closest(".cm-editor") || target.closest("#code-render-pane")) {
      this.spellingIssue = this.dependencies.getSpellingIssue(event.clientX, event.clientY);
      this.spellingSuggestions = this.spellingIssue
        ? await this.dependencies.getSpellingSuggestions(this.spellingIssue)
        : [];
      items = this.editorItems();
    }
    else if (target.closest("#preview-container-wrapper")) items = previewItems;
    else if (target.closest(".editor-tab")) {
      this.targetPath = target.closest<HTMLElement>(".editor-tab")?.dataset.path || "";
      this.targetIsDirectory = false;
      items = this.tabItems();
    } else {
      this.hide();
      return;
    }
    event.preventDefault();
    this.show(items, event.clientX, event.clientY);
  }

  private show(items: string, x: number, y: number, alignRight = false): void {
    this.menu.innerHTML = items;
    this.menu.style.display = "block";
    const rect = this.menu.getBoundingClientRect();
    if (alignRight) x -= rect.width;
    this.menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width))}px`;
    this.menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height))}px`;
  }

  private hide(): void { this.menu.style.display = "none"; }

  private textControlFor(target: HTMLElement): HTMLInputElement | HTMLTextAreaElement | null {
    const control = target.closest<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
    if (!control) return null;
    if (control instanceof HTMLTextAreaElement) return control;
    return ["text", "search", "url", "tel", "email", "password", "number"].includes(control.type)
      ? control
      : null;
  }

  private handlePreviewMessage(event: MessageEvent): void {
    const data = event.data as { type?: unknown; x?: unknown; y?: unknown } | null;
    if (data?.type === "HIDE_CONTEXT_MENU") this.hide();
    if (data?.type !== "SHOW_PREVIEW_CONTEXT_MENU" || typeof data.x !== "number" || typeof data.y !== "number") return;
    const rect = this.dependencies.getPreviewFrame()?.getBoundingClientRect();
    if (rect) this.show(previewItems, rect.left + data.x, rect.top + data.y);
  }

  private explorerItems(): string {
    return `<div class="dropdown-item" id="ctx-new-file">New File</div><div class="dropdown-item" id="ctx-fs-new-folder">New Folder</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-rename">Rename</div><div class="dropdown-item" id="ctx-fs-delete">Delete</div>${this.targetIsDirectory ? "" : '<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-copy">Copy File</div>'}${this.copiedFilePath ? '<div class="dropdown-item" id="ctx-fs-paste">Paste File</div>' : ""}<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-reveal">Reveal in System Explorer</div><div class="dropdown-item" id="ctx-fs-copy-rel-path">Copy Relative Path</div><div class="dropdown-item" id="ctx-fs-copy-abs-path">Copy Absolute Path</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-open-project">Open Workspace</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-restart-workspace">Restart Workspace</div>`;
  }

  private explorerBackgroundItems(): string {
    return `<div class="dropdown-item" id="ctx-new-file">New File</div><div class="dropdown-item" id="ctx-fs-new-folder">New Folder</div>${this.copiedFilePath ? '<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-paste">Paste File</div>' : ""}<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-reveal">Reveal Workspace in Explorer</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-open-project">Open Workspace</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-restart-workspace">Restart Workspace</div>`;
  }

  private tabItems(): string {
    return `<div class="dropdown-item" id="ctx-tab-close">Close</div><div class="dropdown-item" id="ctx-tab-close-others">Close Others</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-copy-rel-path">Copy Relative Path</div><div class="dropdown-item" id="ctx-fs-copy-abs-path">Copy Absolute Path</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-reveal">Reveal in System Explorer</div>`;
  }

  private editorItems(): string {
    const spelling = this.spellingIssue
      ? `${this.spellingSuggestions.map((suggestion, index) => `<div class="dropdown-item spelling-suggestion" id="ctx-spelling-${index}">${this.escapeHtml(suggestion)}</div>`).join("")}<div class="dropdown-separator"></div>`
      : "";
    return `${spelling}<div class="dropdown-item" id="ctx-copy-text">Copy <span class="hotkey">Ctrl+C</span></div><div class="dropdown-item" id="ctx-paste-text">Paste <span class="hotkey">Ctrl+V</span></div><div class="dropdown-item" id="ctx-cut-text">Cut <span class="hotkey">Ctrl+X</span></div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-editor-toggle-comment">Toggle Line Comment</div><div class="dropdown-item" id="ctx-editor-format">Format Document</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-undo">Undo</div><div class="dropdown-item" id="ctx-redo">Redo</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-editor-select-all">Select All</div>`;
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character] ?? character);
  }

  private nativeTextItems(editable: boolean): string {
    const editItems = editable
      ? '<div class="dropdown-item" id="ctx-native-cut">Cut <span class="hotkey">Ctrl+X</span></div><div class="dropdown-item" id="ctx-native-paste">Paste <span class="hotkey">Ctrl+V</span></div>'
      : "";
    const selectAll = editable
      ? '<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-native-select-all">Select All <span class="hotkey">Ctrl+A</span></div>'
      : "";
    return `<div class="dropdown-item" id="ctx-native-copy">Copy <span class="hotkey">Ctrl+C</span></div>${editItems}${selectAll}`;
  }
}

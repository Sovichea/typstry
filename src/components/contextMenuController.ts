import { invoke } from "@tauri-apps/api/core";
import { basename, dirname, join } from "@tauri-apps/api/path";
import { confirm } from "@tauri-apps/plugin-dialog";
import { open } from "@tauri-apps/plugin-shell";
import type { EditorView } from "@codemirror/view";
import { selectAll, toggleLineComment } from "@codemirror/commands";
import type { WorkspaceExplorer } from "./explorer";

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
};

const previewItems = `
  <div class="dropdown-item" id="ctx-preview-open-external">Open in External Viewer</div>
  <div class="dropdown-separator"></div>
  <div class="dropdown-item" id="ctx-export-pdf">Export PDF</div>`;

export class ContextMenuController {
  private targetPath = "";
  private targetIsDirectory = false;
  private copiedFilePath: string | null = null;
  private readonly menu = document.getElementById("context-menu")!;

  constructor(private readonly dependencies: ContextMenuDependencies) {}

  public initialize(): void {
    document.addEventListener("click", () => this.hide());
    this.menu.addEventListener("click", event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>(".dropdown-item")?.id;
      if (action) void this.execute(action);
    });
    document.addEventListener("contextmenu", event => this.showForTarget(event));
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
      case "ctx-copy-text": document.execCommand("copy"); return;
      case "ctx-cut-text": document.execCommand("cut"); return;
      case "ctx-paste-text": return this.pasteText();
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
      case "ctx-fs-copy-abs-path": if (this.targetPath) await navigator.clipboard.writeText(this.targetPath); return;
      case "ctx-preview-open-external": return this.openPreviewPdf();
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
      editor.dispatch(editor.state.replaceSelection(await navigator.clipboard.readText()));
    } catch (error) { console.error("Failed to read clipboard:", error); }
  }

  private async copyRelativePath(): Promise<void> {
    const workspace = this.dependencies.getWorkspaceRoot();
    if (!workspace || !this.targetPath) return;
    const relative = this.targetPath.replace(workspace, "").replace(/^[\\/]/, "").replace(/\\/g, "/");
    await navigator.clipboard.writeText(relative);
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

  private showForTarget(event: MouseEvent): void {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const explorerItem = target.closest<HTMLElement>(".explorer-item-target");
    this.targetPath = explorerItem?.dataset.path || "";
    this.targetIsDirectory = explorerItem?.dataset.isDir === "true";
    let items: string;
    if (explorerItem) items = this.explorerItems();
    else if (target.closest("#explorer-sidebar")) {
      this.targetPath = this.dependencies.getWorkspaceRoot() || "";
      this.targetIsDirectory = !!this.targetPath;
      items = this.explorerBackgroundItems();
    } else if (target.closest(".cm-editor") || target.closest("#code-render-pane")) items = this.editorItems();
    else if (target.closest("#preview-container-wrapper")) items = previewItems;
    else items = '<div class="dropdown-item" id="ctx-open-project">Open Workspace <span class="hotkey">Ctrl+K Ctrl+O</span></div>';
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

  private handlePreviewMessage(event: MessageEvent): void {
    const data = event.data as { type?: unknown; x?: unknown; y?: unknown } | null;
    if (data?.type === "HIDE_CONTEXT_MENU") this.hide();
    if (data?.type !== "SHOW_PREVIEW_CONTEXT_MENU" || typeof data.x !== "number" || typeof data.y !== "number") return;
    const rect = this.dependencies.getPreviewFrame()?.getBoundingClientRect();
    if (rect) this.show(previewItems, rect.left + data.x, rect.top + data.y);
  }

  private explorerItems(): string {
    return `<div class="dropdown-item" id="ctx-new-file">New File</div><div class="dropdown-item" id="ctx-fs-new-folder">New Folder</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-rename">Rename</div><div class="dropdown-item" id="ctx-fs-delete">Delete</div>${this.targetIsDirectory ? "" : '<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-copy">Copy File</div>'}${this.copiedFilePath ? '<div class="dropdown-item" id="ctx-fs-paste">Paste File</div>' : ""}<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-reveal">Reveal in System Explorer</div><div class="dropdown-item" id="ctx-fs-copy-rel-path">Copy Relative Path</div><div class="dropdown-item" id="ctx-fs-copy-abs-path">Copy Absolute Path</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-open-project">Open Workspace</div>`;
  }

  private explorerBackgroundItems(): string {
    return `<div class="dropdown-item" id="ctx-new-file">New File</div><div class="dropdown-item" id="ctx-fs-new-folder">New Folder</div>${this.copiedFilePath ? '<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-paste">Paste File</div>' : ""}<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-reveal">Reveal Workspace in Explorer</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-open-project">Open Workspace</div>`;
  }

  private editorItems(): string {
    return `<div class="dropdown-item" id="ctx-copy-text">Copy <span class="hotkey">Ctrl+C</span></div><div class="dropdown-item" id="ctx-paste-text">Paste <span class="hotkey">Ctrl+V</span></div><div class="dropdown-item" id="ctx-cut-text">Cut <span class="hotkey">Ctrl+X</span></div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-editor-toggle-comment">Toggle Line Comment</div><div class="dropdown-item" id="ctx-editor-format">Format Document</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-undo">Undo</div><div class="dropdown-item" id="ctx-redo">Redo</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-editor-select-all">Select All</div>`;
  }
}

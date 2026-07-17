import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { createAppIcon, type AppIconName } from "../ui/icons";
import { filePathKey, relativeFilePath } from "../platform/paths";

export interface FileNode { name: string; path: string; isDirectory: boolean; children?: FileNode[]; }

export type ExplorerSelection = { path: string; isDirectory: boolean };

export function sortFileNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
}

export function workspacePathSetContains(paths: ReadonlySet<string>, targetPath: string): boolean {
  const targetKey = filePathKey(targetPath);
  return [...paths].some(path => filePathKey(path) === targetKey);
}

export function workspaceParentDirectories(rootPath: string, targetPath: string): string[] {
  const relative = relativeFilePath(rootPath, targetPath);
  if (relative === null || relative === "") return [];
  const components = relative.replace(/\\/g, "/").split("/").filter(Boolean);
  components.pop();
  const root = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
  const parents: string[] = [];
  for (let length = components.length; length > 0; length--) {
    parents.push(`${root}/${components.slice(0, length).join("/")}`);
  }
  return parents;
}

function getFileIconSvg(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const icon: AppIconName = ext === "typ"
    ? "fileCode"
    : ext === "pdf" || ["md", "txt", "csv"].includes(ext ?? "")
      ? "fileText"
      : ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext ?? "")
        ? "fileImage"
        : ["toml", "json", "yaml", "yml", "xml"].includes(ext ?? "")
          ? "fileCog"
          : "file";
  const color = ext === "typ" ? "#239dad"
    : ext === "pdf" ? "#e53935"
      : ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext ?? "") ? "#4caf50"
        : ["toml", "json", "yaml", "yml", "xml"].includes(ext ?? "") ? "#ffb300"
          : "#78909c";
  return createAppIcon(icon, { size: 16, color }).outerHTML;
}

export function isHiddenWorkspaceEntry(name: string): boolean {
  return name === ".typsastra" || name === ".typstella";
}

export class WorkspaceExplorer {
  private loadGeneration = 0;
  private workspaceRootPath: string | null = null;
  private activeFilePath: string | null = null;

  constructor(
    private container: HTMLElement,
    private onFileSelected: (filePath: string, options?: { temporary?: boolean; focusEditor?: boolean }) => void,
    private isPinnedMainFile?: (filePath: string) => boolean
  ) {
    this.container.tabIndex = 0;
    this.container.setAttribute("role", "tree");
    this.container.setAttribute("aria-label", "Workspace Explorer");
    this.container.addEventListener("pointerdown", event => {
      if (!(event.target as HTMLElement).closest("input, textarea")) {
        this.container.focus({ preventScroll: true });
      }
    });
    this.container.addEventListener("focus", () => this.ensureKeyboardSelection());
    this.container.addEventListener("keydown", event => void this.handleKeyboardNavigation(event));
  }

  public selectedEntry(): ExplorerSelection | null {
    const item = this.container.querySelector<HTMLElement>(".tree-item.selected[data-path]");
    const path = item?.dataset.path;
    return path ? { path, isDirectory: item.dataset.isDir === "true" } : null;
  }

  public focus(): void {
    this.container.focus({ preventScroll: true });
    this.ensureKeyboardSelection();
  }

  private visibleItems(): HTMLElement[] {
    return [...this.container.querySelectorAll<HTMLElement>(".tree-item[data-path]")]
      .filter(item => item.getClientRects().length > 0);
  }

  private selectItem(item: HTMLElement): void {
    this.container.querySelectorAll<HTMLElement>(".tree-item.selected").forEach(current => {
      current.classList.remove("selected");
      current.setAttribute("aria-selected", "false");
    });
    item.classList.add("selected");
    item.setAttribute("aria-selected", "true");
    item.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private ensureKeyboardSelection(): void {
    if (this.selectedEntry()) return;
    const item = this.container.querySelector<HTMLElement>(".tree-item.active-file[data-path]")
      ?? this.visibleItems()[0];
    if (item) this.selectItem(item);
  }

  private async handleKeyboardNavigation(event: KeyboardEvent): Promise<void> {
    if ((event.target as HTMLElement).closest("input, textarea")) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
    this.ensureKeyboardSelection();
    const items = this.visibleItems();
    const selected = this.container.querySelector<HTMLElement>(".tree-item.selected[data-path]");
    if (!selected || !items.length) return;
    event.preventDefault();
    event.stopPropagation();

    const index = Math.max(0, items.indexOf(selected));
    if (event.key === "ArrowUp") this.selectItem(items[Math.max(0, index - 1)]);
    else if (event.key === "ArrowDown") this.selectItem(items[Math.min(items.length - 1, index + 1)]);
    else if (event.key === "Home") this.selectItem(items[0]);
    else if (event.key === "End") this.selectItem(items[items.length - 1]);
    else if (event.key === "Enter") {
      if (selected.dataset.isDir === "true") selected.click();
      else if (selected.dataset.path) this.onFileSelected(selected.dataset.path, { temporary: false, focusEditor: false });
    } else if (event.key === "ArrowRight" && selected.dataset.isDir === "true") {
      const folder = selected.closest("li.tree-folder");
      if (folder?.classList.contains("collapsed")) selected.click();
      else if (items[index + 1]) this.selectItem(items[index + 1]);
    } else if (event.key === "ArrowLeft") {
      const folder = selected.closest("li.tree-folder");
      if (selected.dataset.isDir === "true" && folder && !folder.classList.contains("collapsed")) {
        selected.click();
      } else {
        const parent = selected.closest("li")?.parentElement?.closest("li.tree-folder")
          ?.querySelector<HTMLElement>(":scope > .tree-item[data-path]");
        if (parent) this.selectItem(parent);
      }
    }
  }

  public setActiveFile(filePath: string | null): void {
    this.activeFilePath = filePath;
    const activeKey = filePath === null ? null : filePathKey(filePath);
    this.container.querySelectorAll<HTMLElement>(".tree-item[data-path]").forEach(item => {
      const active = activeKey !== null && filePathKey(item.dataset.path ?? "") === activeKey;
      item.classList.toggle("active-file", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
  }

  public expandedDirectoryPaths(): string[] {
    return [...this.captureViewState().expandedPaths];
  }

  public async loadWorkspace(rootPath: string, initialExpandedPaths: readonly string[] = []) {
    this.workspaceRootPath = rootPath;
    const generation = ++this.loadGeneration;
    const viewState = this.captureViewState();
    initialExpandedPaths.forEach(path => viewState.expandedPaths.add(path));
    const isFirstLoad = !this.container.querySelector(".file-tree-branch");
    if (isFirstLoad) {
      this.container.innerHTML = `<div class="explorer-loading">Scanning Workspace...</div>`;
    }
    try {
      const nodes = await this.readDirectory(rootPath);
      await this.hydrateExpandedDirectories(nodes, viewState.expandedPaths);
      if (generation !== this.loadGeneration) return;
      this.container.innerHTML = "";

      this.container.appendChild(this.renderTree(nodes, 0, viewState.expandedPaths, viewState.selectedPath));
    } catch {
      if (generation !== this.loadGeneration) return;
      this.container.innerHTML = `<div class="explorer-error">Access Refused.</div>`;
    }
  }

  public async revealPath(targetPath: string): Promise<void> {
    if (!this.workspaceRootPath) return;

    const parents = workspaceParentDirectories(this.workspaceRootPath, targetPath);

    const viewState = this.captureViewState();
    for (const parent of parents) {
      viewState.expandedPaths.add(parent);
    }
    viewState.selectedPath = targetPath;

    const generation = ++this.loadGeneration;
    try {
      const nodes = await this.readDirectory(this.workspaceRootPath);
      await this.hydrateExpandedDirectories(nodes, viewState.expandedPaths);
      if (generation !== this.loadGeneration) return;
      this.container.innerHTML = "";
      this.container.appendChild(this.renderTree(nodes, 0, viewState.expandedPaths, viewState.selectedPath));

      const targetKey = filePathKey(targetPath);
      const selectedEl = [...this.container.querySelectorAll<HTMLElement>(".tree-item[data-path]")]
        .find(item => filePathKey(item.dataset.path ?? "") === targetKey);
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    } catch (e) {
      console.warn("Failed to reveal path in explorer:", targetPath, e);
    }
  }

  private captureViewState(): { expandedPaths: Set<string>; selectedPath: string | null } {
    const expandedPaths = new Set<string>();
    this.container.querySelectorAll<HTMLElement>(".tree-folder:not(.collapsed) > .tree-item[data-path]")
      .forEach(item => {
        if (item.dataset.path) expandedPaths.add(item.dataset.path);
      });
    const selectedPath = this.container.querySelector<HTMLElement>(".tree-item.selected[data-path]")?.dataset.path ?? null;
    return { expandedPaths, selectedPath };
  }

  private async hydrateExpandedDirectories(nodes: FileNode[], expandedPaths: Set<string>): Promise<void> {
    await Promise.all(nodes.map(async node => {
      if (!node.isDirectory || !workspacePathSetContains(expandedPaths, node.path)) return;
      node.children = await this.readDirectory(node.path);
      await this.hydrateExpandedDirectories(node.children, expandedPaths);
    }));
  }

  private async readDirectory(dirPath: string): Promise<FileNode[]> {
    const entries: {name: string, isDirectory: boolean}[] = await invoke("read_workspace_dir", { path: dirPath });
    const visibleEntries = entries.filter(entry => !isHiddenWorkspaceEntry(entry.name));
    const nodes = await Promise.all(visibleEntries.map(async entry => ({
      name: entry.name,
      path: await join(dirPath, entry.name),
      isDirectory: entry.isDirectory
    })));
    return sortFileNodes(nodes);
  }

  private renderTree(
    nodes: FileNode[],
    depth: number = 0,
    expandedPaths: Set<string> = new Set(),
    selectedPath: string | null = null
  ): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const ul = document.createElement("ul");
    ul.className = "file-tree-branch";

    for (const node of nodes) {
      const li = document.createElement("li");
      const isExpanded = node.isDirectory && workspacePathSetContains(expandedPaths, node.path);
      li.className = node.isDirectory ? `tree-folder${isExpanded ? "" : " collapsed"}` : "tree-file";

      const label = document.createElement("div");
      const isPinnedMain = this.isPinnedMainFile ? this.isPinnedMainFile(node.path) : false;
      const isActiveFile = !node.isDirectory
        && this.activeFilePath !== null
        && filePathKey(this.activeFilePath) === filePathKey(node.path);
      const isSelected = selectedPath !== null && filePathKey(selectedPath) === filePathKey(node.path);
      label.className = `tree-item explorer-item-target${isSelected ? " selected" : ""}${isActiveFile ? " active-file" : ""}${isPinnedMain ? " pinned-main" : ""}`;
      label.dataset.path = node.path;
      label.dataset.isDir = String(node.isDirectory);
      label.setAttribute("role", "treeitem");
      label.setAttribute("aria-selected", String(isSelected));
      if (isActiveFile) label.setAttribute("aria-current", "page");
      // Base padding + depth padding
      label.style.paddingLeft = `${depth * 12 + 8}px`;

      const chevronContainer = document.createElement("span");
      chevronContainer.className = node.isDirectory
        ? `tree-chevron${isExpanded ? "" : " collapsed"}`
        : "tree-chevron-spacer";
      if (node.isDirectory) {
        // Down pointing chevron (default expanded, will be rotated -90deg by .collapsed)
        chevronContainer.appendChild(createAppIcon("chevronDown", { size: 16 }));
      }
      label.appendChild(chevronContainer);

      const iconContainer = document.createElement("span");
      iconContainer.className = "tree-icon";
      if (node.isDirectory) {
        // Folder icon
        iconContainer.appendChild(createAppIcon("folder", { size: 16, color: "#e8a838" }));
      } else {
        // File icon
        iconContainer.innerHTML = getFileIconSvg(node.name);
      }
      label.appendChild(iconContainer);

      const textContainer = document.createElement("span");
      textContainer.className = "tree-text";
      textContainer.textContent = node.name;
      label.appendChild(textContainer);

      if (!node.isDirectory) {
        label.addEventListener("click", () => {
          this.container.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
          label.classList.add('selected');
          this.onFileSelected(node.path, { temporary: true, focusEditor: false });
        });
        label.addEventListener("dblclick", () => {
          this.onFileSelected(node.path, { temporary: false, focusEditor: false });
        });
      } else {
        const childrenContainer = document.createElement("div");
        childrenContainer.className = "tree-children";
        let loading = false;

        if (node.children) {
          childrenContainer.appendChild(this.renderTree(node.children, depth + 1, expandedPaths, selectedPath));
        }

        label.addEventListener("click", async () => {
          this.container.querySelectorAll(".tree-item.selected").forEach(item => item.classList.remove("selected"));
          label.classList.add("selected");
          const expanding = li.classList.contains("collapsed");
          li.classList.toggle("collapsed", !expanding);
          chevronContainer.classList.toggle("collapsed", !expanding);

          if (!expanding || node.children || loading) return;

          loading = true;
          label.classList.add("loading");
          try {
            node.children = await this.readDirectory(node.path);
            childrenContainer.replaceChildren(this.renderTree(node.children, depth + 1, expandedPaths, selectedPath));
          } catch {
            const error = document.createElement("div");
            error.className = "explorer-error";
            error.style.paddingLeft = `${(depth + 1) * 12 + 8}px`;
            error.textContent = "Unable to read folder.";
            childrenContainer.replaceChildren(error);
          } finally {
            loading = false;
            label.classList.remove("loading");
          }
        });
        li.appendChild(childrenContainer);
      }

      li.insertBefore(label, li.firstChild);
      ul.appendChild(li);
    }
    fragment.appendChild(ul);
    return fragment;
  }

  public showInlineInput(targetDirPath: string | null, type: "file" | "folder" | "rename", defaultValue: string = "", onComplete: (name: string | null) => void) {
    let parentContainer: HTMLElement;
    let depth = 0;
    let targetLabel: HTMLElement | null = null;

    if (type === "rename" && targetDirPath) {
       targetLabel = this.container.querySelector(`[data-path="${targetDirPath.replace(/\\/g, '\\\\')}"]`) as HTMLElement;
       if (!targetLabel) { onComplete(null); return; }
       parentContainer = targetLabel.parentElement!;
       depth = parseInt(targetLabel.style.paddingLeft || "8") / 12; 
       // Subtract 8 base padding: depth = (padding - 8) / 12. But wait, let's just use the padding of the target label.
    } else if (targetDirPath) {
       targetLabel = this.container.querySelector(`[data-path="${targetDirPath.replace(/\\/g, '\\\\')}"]`) as HTMLElement;
       if (!targetLabel) {
           parentContainer = this.container.querySelector(".file-tree-branch") as HTMLElement;
       } else {
           const li = targetLabel.parentElement!;
           li.classList.remove("collapsed"); // Expand folder
           let childrenContainer = li.querySelector(".tree-children") as HTMLElement;
           if (!childrenContainer) {
               childrenContainer = document.createElement("div");
               childrenContainer.className = "tree-children";
               const newBranch = document.createElement("ul");
               newBranch.className = "file-tree-branch";
               childrenContainer.appendChild(newBranch);
               li.appendChild(childrenContainer);
           }
           parentContainer = childrenContainer.querySelector(".file-tree-branch") as HTMLElement;
           depth = (parseInt(targetLabel.style.paddingLeft || "8") - 8) / 12 + 1;
       }
    } else {
       parentContainer = this.container.querySelector(".file-tree-branch") as HTMLElement;
    }

    if (!parentContainer) { onComplete(null); return; }

    const inputLi = document.createElement("li");
    inputLi.className = type === "folder" ? "tree-folder" : "tree-file";
    
    const label = document.createElement("div");
    label.className = "tree-item";
    let paddingLeft = type === "rename" && targetLabel ? targetLabel.style.paddingLeft : `${depth * 12 + 8}px`;
    label.style.paddingLeft = paddingLeft;

    const chevronSpacer = document.createElement("span");
    chevronSpacer.className = "tree-chevron-spacer";
    label.appendChild(chevronSpacer);

    const iconContainer = document.createElement("span");
    iconContainer.className = "tree-icon";
    if (type === "folder") {
        iconContainer.appendChild(createAppIcon("folder", { size: 16, color: "#e8a838" }));
    } else {
        iconContainer.innerHTML = getFileIconSvg(defaultValue || "new.typ");
    }
    label.appendChild(iconContainer);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "explorer-inline-input";
    input.value = defaultValue;
    input.style.width = "100%";
    input.style.background = "transparent";
    input.style.border = "1px solid #007acc";
    input.style.color = "var(--text-color)";
    input.style.outline = "none";
    input.style.marginLeft = "4px";

    if (type === "rename" && targetLabel) {
       targetLabel.style.display = "none";
       inputLi.appendChild(label);
       parentContainer.insertBefore(inputLi, targetLabel.nextSibling);
    } else {
       label.appendChild(input);
       inputLi.appendChild(label);
       parentContainer.insertBefore(inputLi, parentContainer.firstChild);
    }

    if (type === "rename") {
       label.appendChild(input);
    }

    input.focus();
    if (defaultValue) {
      const dotIndex = defaultValue.lastIndexOf(".");
      if (dotIndex > 0) input.setSelectionRange(0, dotIndex);
      else input.select();
    }

    let isHandled = false;
    const finish = (value: string | null) => {
        if (isHandled) return;
        isHandled = true;
        inputLi.remove();
        if (type === "rename" && targetLabel) targetLabel.style.display = "";
        onComplete(value);
    };

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            finish(input.value.trim());
        } else if (e.key === "Escape") {
            e.preventDefault();
            finish(null);
        }
    });

    input.addEventListener("blur", () => {
        finish(input.value.trim() || null);
    });
  }
}

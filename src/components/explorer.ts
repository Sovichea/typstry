import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { createAppIcon, type AppIconName } from "../ui/icons";

export interface FileNode { name: string; path: string; isDirectory: boolean; children?: FileNode[]; }

export function sortFileNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
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
  return name === ".typstry";
}

export class WorkspaceExplorer {
  private loadGeneration = 0;

  constructor(
    private container: HTMLElement,
    private onFileSelected: (filePath: string, options?: { temporary?: boolean }) => void,
    private isPinnedMainFile?: (filePath: string) => boolean
  ) {}

  public async loadWorkspace(rootPath: string) {
    const generation = ++this.loadGeneration;
    const viewState = this.captureViewState();
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
      if (!node.isDirectory || !expandedPaths.has(node.path)) return;
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
      const isExpanded = node.isDirectory && expandedPaths.has(node.path);
      li.className = node.isDirectory ? `tree-folder${isExpanded ? "" : " collapsed"}` : "tree-file";

      const label = document.createElement("div");
      const isPinnedMain = this.isPinnedMainFile ? this.isPinnedMainFile(node.path) : false;
      label.className = `tree-item explorer-item-target${selectedPath === node.path ? " selected" : ""}${isPinnedMain ? " pinned-main" : ""}`;
      label.dataset.path = node.path;
      label.dataset.isDir = String(node.isDirectory);
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
          document.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
          label.classList.add('selected');
          this.onFileSelected(node.path, { temporary: true });
        });
        label.addEventListener("dblclick", () => {
          this.onFileSelected(node.path, { temporary: false });
        });
      } else {
        const childrenContainer = document.createElement("div");
        childrenContainer.className = "tree-children";
        let loading = false;

        if (node.children) {
          childrenContainer.appendChild(this.renderTree(node.children, depth + 1, expandedPaths, selectedPath));
        }

        label.addEventListener("click", async () => {
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

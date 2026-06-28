import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";

export interface FileNode { name: string; path: string; isDirectory: boolean; children?: FileNode[]; }

export function sortFileNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
}

function getFileIconSvg(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  
  switch (ext) {
    case 'typ':
      // Typst logoish (Blue)
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="#239dad"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm-2 16c-2.05 0-3.81-1.24-4.58-3h1.71c.63.9 1.68 1.5 2.87 1.5 1.93 0 3.5-1.57 3.5-3.5S13.93 9.5 12 9.5c-1.35 0-2.52.78-3.1 1.9l1.6 1.6h-4V9l1.3 1.3C8.69 8.92 10.23 8 12 8c2.76 0 5 2.24 5 5s-2.24 5-5 5z"/></svg>`;
    
    case 'pdf':
      // PDF document (Red)
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="#E53935"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z"/></svg>`;
      
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
    case 'ico':
      // Image (Green)
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="#4CAF50"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`;
      
    case 'toml':
    case 'json':
    case 'yaml':
    case 'yml':
    case 'xml':
      // Settings / Config (Yellow)
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="#FFB300"><path d="M19.3 16.9c.4-.7.7-1.5.8-2.4l2.8-.4c.1-.8.1-1.7 0-2.5l-2.8-.4c-.1-.9-.4-1.7-.8-2.4l1.9-2.1c-.6-.6-1.2-1.1-1.9-1.5l-2.4 1.4c-.7-.4-1.5-.7-2.3-.9l-.6-2.7h-2.5l-.6 2.7c-.8.2-1.6.5-2.3.9L6.2 4.4c-.6.4-1.3.9-1.9 1.5l1.9 2.1c-.4.7-.7 1.5-.8 2.4l-2.8.4c-.1.8-.1 1.7 0 2.5l2.8.4c.1.9.4 1.7.8 2.4l-1.9 2.1c.6.6 1.2 1.1 1.9 1.5l2.4-1.4c.7.4 1.5.7 2.3.9l.6 2.7h2.5l.6-2.7c.8-.2 1.6-.5 2.3-.9l2.4 1.4c.6-.4 1.3-.9 1.9-1.5l-1.9-2.1zM12 15c-1.7 0-3-1.3-3-3s1.3-3 3-3 3 1.3 3 3-1.3 3-3 3z"/></svg>`;
      
    case 'md':
    case 'txt':
    case 'csv':
      // Text file (Grey)
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="#90A4AE"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`;
      
    default:
      // Generic File (Blue-ish)
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="#519aba"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`;
  }
}

export class WorkspaceExplorer {
  constructor(private container: HTMLElement, private onFileSelected: (filePath: string) => void) {}

  public async loadWorkspace(rootPath: string) {
    const isFirstLoad = !this.container.querySelector(".file-tree-branch");
    if (isFirstLoad) {
      this.container.innerHTML = `<div class="explorer-loading">Scanning Workspace...</div>`;
    }
    try {
      const nodes = await this.readDirectory(rootPath);
      this.container.innerHTML = "";
      
      const header = document.createElement("div");
      header.className = "explorer-header";
      header.textContent = "EXPLORER";
      this.container.appendChild(header);

      this.container.appendChild(this.renderTree(nodes));
    } catch {
      this.container.innerHTML = `<div class="explorer-error">Access Refused.</div>`;
    }
  }

  private async readDirectory(dirPath: string): Promise<FileNode[]> {
    const entries: {name: string, isDirectory: boolean}[] = await invoke("read_workspace_dir", { path: dirPath });
    const nodes = await Promise.all(entries.map(async entry => ({
      name: entry.name,
      path: await join(dirPath, entry.name),
      isDirectory: entry.isDirectory
    })));
    return sortFileNodes(nodes);
  }

  private renderTree(nodes: FileNode[], depth: number = 0): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const ul = document.createElement("ul");
    ul.className = "file-tree-branch";

    for (const node of nodes) {
      const li = document.createElement("li");
      li.className = node.isDirectory ? "tree-folder collapsed" : "tree-file";

      const label = document.createElement("div");
      label.className = "tree-item explorer-item-target";
      label.dataset.path = node.path;
      label.dataset.isDir = String(node.isDirectory);
      // Base padding + depth padding
      label.style.paddingLeft = `${depth * 12 + 8}px`;

      const chevronContainer = document.createElement("span");
      chevronContainer.className = node.isDirectory ? "tree-chevron collapsed" : "tree-chevron-spacer";
      if (node.isDirectory) {
        // Down pointing chevron (default expanded, will be rotated -90deg by .collapsed)
        chevronContainer.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"/></svg>`;
      }
      label.appendChild(chevronContainer);

      const iconContainer = document.createElement("span");
      iconContainer.className = "tree-icon";
      if (node.isDirectory) {
        // Folder icon
        iconContainer.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" color="#e8a838"><path d="M7 2l2 2h5v9H2V2h5zm0 1H3v9h10V5H8.5L6.5 3H7z"/></svg>`;
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
          this.onFileSelected(node.path);
        });
      } else {
        const childrenContainer = document.createElement("div");
        childrenContainer.className = "tree-children";
        let loading = false;

        label.addEventListener("click", async () => {
          const expanding = li.classList.contains("collapsed");
          li.classList.toggle("collapsed", !expanding);
          chevronContainer.classList.toggle("collapsed", !expanding);

          if (!expanding || node.children || loading) return;

          loading = true;
          label.classList.add("loading");
          try {
            node.children = await this.readDirectory(node.path);
            childrenContainer.replaceChildren(this.renderTree(node.children, depth + 1));
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
        iconContainer.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" color="#e8a838"><path d="M7 2l2 2h5v9H2V2h5zm0 1H3v9h10V5H8.5L6.5 3H7z"/></svg>`;
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

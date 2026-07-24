import { invoke } from "@tauri-apps/api/core";
import { filePathKey } from "../platform/paths";
import { createAppIcon } from "../ui/icons";

const storageKey = "typsastra-recent-projects";
const maxRecentProjects = 32;
const visibleRecentProjects = 5;

export function recentProjectShortcutIndex(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): number | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return null;
  const match = /^Digit([1-5])$/.exec(event.code);
  return match ? Number(match[1]) - 1 : null;
}

export function recentProjectNavigationIndex(
  currentIndex: number,
  resultCount: number,
  key: "ArrowUp" | "ArrowDown"
): number | null {
  if (resultCount <= 0) return null;
  const current = Math.max(0, Math.min(currentIndex, resultCount - 1));
  return key === "ArrowDown"
    ? Math.min(current + 1, resultCount - 1)
    : Math.max(current - 1, 0);
}

export function normalizeRecentProjects(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const projects: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const path = candidate.trim();
    const key = filePathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push(path);
    if (projects.length === maxRecentProjects) break;
  }
  return projects;
}

export function filterRecentProjects(projects: readonly string[], query: string): string[] {
  const normalizedQuery = normalizeSearchText(query).trim();
  if (!normalizedQuery) return [...projects];
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  return projects
    .map((path, index) => {
      const nameScore = fuzzyTextScore(normalizeSearchText(projectName(path)), tokens);
      const pathScore = fuzzyTextScore(normalizeSearchText(path), tokens);
      const score = Math.min(nameScore ?? Number.POSITIVE_INFINITY, (pathScore ?? Number.POSITIVE_INFINITY) + 400);
      return { path, index, score };
    })
    .filter(result => Number.isFinite(result.score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(result => result.path);
}

export function removeRecentProject(projects: readonly string[], path: string): string[] {
  const removedKey = filePathKey(path);
  return projects.filter(project => filePathKey(project) !== removedKey);
}

export async function recentProjectPathAvailable(
  path: string,
  pathExists: (path: string) => boolean | Promise<boolean>
): Promise<boolean> {
  try {
    return await pathExists(path);
  } catch {
    // A transient backend failure must not silently remove a valid project.
    // Let the normal workspace-opening path report the underlying error.
    return true;
  }
}

export async function notifyBeforeRemovingRecentProject(
  path: string,
  notify: (path: string) => void | Promise<void>,
  remove: (path: string) => void
): Promise<void> {
  await notify(path);
  remove(path);
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase();
}

function fuzzyTextScore(text: string, tokens: readonly string[]): number | null {
  let score = 0;
  for (const token of tokens) {
    const tokenScore = fuzzyTokenScore(text, token);
    if (tokenScore === null) return null;
    score += tokenScore;
  }
  return score;
}

function fuzzyTokenScore(text: string, token: string): number | null {
  if (text === token) return 0;
  const contiguousIndex = text.indexOf(token);
  if (contiguousIndex >= 0) {
    const boundaryBonus = contiguousIndex === 0 || /[/\\\s._-]/u.test(text[contiguousIndex - 1]) ? -20 : 0;
    return 20 + contiguousIndex + boundaryBonus + Math.max(0, text.length - token.length) * 0.01;
  }

  const textCharacters = Array.from(text);
  const tokenCharacters = Array.from(token);
  let previousIndex = -1;
  let firstIndex = -1;
  let gaps = 0;
  let consecutive = 0;
  for (const character of tokenCharacters) {
    const index = textCharacters.indexOf(character, previousIndex + 1);
    if (index < 0) return null;
    if (firstIndex < 0) firstIndex = index;
    if (previousIndex >= 0) {
      const gap = index - previousIndex - 1;
      gaps += gap;
      if (gap === 0) consecutive += 1;
    }
    previousIndex = index;
  }

  const startsAtBoundary = firstIndex === 0 || /[/\\\s._-]/u.test(textCharacters[firstIndex - 1] ?? "");
  return 100 + firstIndex * 2 + gaps * 4 - consecutive * 3 - (startsAtBoundary ? 12 : 0)
    + Math.max(0, textCharacters.length - tokenCharacters.length) * 0.01;
}

function projectName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

export class RecentProjectsController {
  private popupOverlay: HTMLElement | null = null;
  private popupSearch: HTMLInputElement | null = null;
  private popupList: HTMLElement | null = null;
  private popupSelectionIndex = 0;

  constructor(
    private readonly onOpen: (path: string) => void | Promise<void>,
    private readonly onMissing: (path: string) => void | Promise<void> = () => {},
    private readonly pathExists: (path: string) => boolean | Promise<boolean> =
      path => invoke<boolean>("workspace_path_exists", { path })
  ) {}

  public initialize(): void {
    this.popupOverlay = document.getElementById("recent-projects-overlay");
    this.popupSearch = document.getElementById("recent-projects-search") as HTMLInputElement | null;
    this.popupList = document.getElementById("recent-projects-list");

    this.popupSearch?.addEventListener("input", () => {
      this.popupSelectionIndex = 0;
      this.renderPopupList();
    });
    this.popupSearch?.addEventListener("keydown", event => this.handlePopupSearchKeydown(event));
    document.getElementById("recent-projects-close")?.addEventListener("click", () => this.closePopup());
    document.getElementById("recent-projects-done")?.addEventListener("click", () => this.closePopup());
    this.popupOverlay?.addEventListener("click", event => {
      if (event.target === this.popupOverlay) this.closePopup();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !this.popupOverlay?.classList.contains("hidden")) {
        event.preventDefault();
        this.closePopup();
      }
    });

    this.render();
  }

  public add(path: string): void {
    const recent = normalizeRecentProjects([path, ...this.read()]);
    localStorage.setItem(storageKey, JSON.stringify(recent));
    this.render();
    if (!this.popupOverlay?.classList.contains("hidden")) this.renderPopupList();
  }

  public openAt(index: number): boolean {
    const path = this.read()[index];
    if (!path) return false;
    void this.openProject(path);
    return true;
  }

  public showPopup(): void {
    if (!this.popupOverlay) return;
    if (this.popupSearch) this.popupSearch.value = "";
    this.popupSelectionIndex = 0;
    this.renderPopupList();
    this.popupOverlay.classList.remove("hidden");
    this.popupSearch?.setAttribute("aria-expanded", "true");
    window.requestAnimationFrame(() => this.popupSearch?.focus());
  }

  private async openProject(path: string): Promise<void> {
    if (!await recentProjectPathAvailable(path, this.pathExists)) {
      await notifyBeforeRemovingRecentProject(path, this.onMissing, missingPath => {
        const remaining = removeRecentProject(this.read(), missingPath);
        localStorage.setItem(storageKey, JSON.stringify(remaining));
        this.render();
        if (!this.popupOverlay?.classList.contains("hidden")) {
          this.popupSelectionIndex = 0;
          this.renderPopupList();
        }
      });
      return;
    }
    this.closePopup();
    await this.onOpen(path);
  }

  private closePopup(): void {
    this.popupOverlay?.classList.add("hidden");
    this.popupSearch?.setAttribute("aria-expanded", "false");
  }

  private read(): string[] {
    try {
      return normalizeRecentProjects(JSON.parse(localStorage.getItem(storageKey) || "[]"));
    } catch {
      return [];
    }
  }

  private render(): void {
    const projects = this.read();
    this.renderWelcome(projects.slice(0, visibleRecentProjects));
    this.renderFileMenu(projects.slice(0, visibleRecentProjects));
  }

  private renderWelcome(projects: readonly string[]): void {
    const section = document.getElementById("welcome-recent-projects");
    if (!section) return;
    section.replaceChildren();
    const title = document.createElement("div");
    title.className = "welcome-section-title";
    title.textContent = "RECENT PROJECTS";
    section.appendChild(title);

    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "welcome-empty";
      empty.textContent = "No recent projects";
      section.appendChild(empty);
      return;
    }

    projects.forEach((path, index) => {
      const item = this.createWelcomeItem(path, `Ctrl+${index + 1}`);
      item.addEventListener("click", () => this.openProject(path));
      section.appendChild(item);
    });

    const showMore = document.createElement("button");
    showMore.type = "button";
    showMore.className = "welcome-item welcome-show-recent";
    showMore.append(
      this.icon("list", "welcome-item-icon"),
      this.text("Show All Recent Projects…", "welcome-item-text")
    );
    showMore.addEventListener("click", () => this.showPopup());
    section.appendChild(showMore);
  }

  private renderFileMenu(projects: readonly string[]): void {
    const menu = document.getElementById("recent-projects-submenu");
    if (!menu) return;
    menu.replaceChildren();

    if (!projects.length) {
      const empty = this.text("No recent projects", "dropdown-item dropdown-item-disabled");
      menu.appendChild(empty);
    } else {
      projects.forEach(path => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "dropdown-item recent-project-menu-item";
        item.title = path;
        item.append(
          this.text(projectName(path), "recent-project-menu-name"),
          this.text(path, "recent-project-menu-path")
        );
        item.addEventListener("click", event => {
          event.stopPropagation();
          this.openProject(path);
          document.querySelectorAll("#app-menus .dropdown-container.active")
            .forEach(container => container.classList.remove("active"));
        });
        menu.appendChild(item);
      });
    }

    const separator = document.createElement("div");
    separator.className = "dropdown-separator";
    separator.setAttribute("role", "separator");
    menu.appendChild(separator);

    const showAll = document.createElement("button");
    showAll.type = "button";
    showAll.className = "dropdown-item";
    showAll.textContent = "Show All Recent Projects…";
    showAll.addEventListener("click", event => {
      event.stopPropagation();
      this.showPopup();
      document.querySelectorAll("#app-menus .dropdown-container.active")
        .forEach(container => container.classList.remove("active"));
    });
    menu.appendChild(showAll);
  }

  private renderPopupList(): void {
    if (!this.popupList) return;
    const popupList = this.popupList;
    const projects = filterRecentProjects(this.read(), this.popupSearch?.value ?? "");
    popupList.replaceChildren();
    if (!projects.length) {
      this.popupSelectionIndex = 0;
      this.popupSearch?.removeAttribute("aria-activedescendant");
      const empty = this.text(
        this.read().length ? "No recent projects match your search." : "No recent projects yet.",
        "recent-projects-empty"
      );
      popupList.appendChild(empty);
      return;
    }

    projects.forEach((path, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "recent-projects-list-item";
      item.id = `recent-project-result-${index}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      item.title = path;
      const detail = document.createElement("span");
      detail.className = "recent-projects-list-detail";
      detail.append(
        this.text(projectName(path), "recent-projects-list-name"),
        this.text(path, "recent-projects-list-path")
      );
      item.append(this.icon("folder", "recent-projects-list-icon"), detail);
      item.addEventListener("click", () => this.openProject(path));
      item.addEventListener("pointermove", () => this.selectPopupResult(index, false));
      item.addEventListener("focus", () => this.selectPopupResult(index, false));
      popupList.appendChild(item);
    });
    this.selectPopupResult(Math.min(this.popupSelectionIndex, projects.length - 1), false);
  }

  private handlePopupSearchKeydown(event: KeyboardEvent): void {
    const items = this.popupResultItems();
    if (event.key === "Enter") {
      const selected = items[this.popupSelectionIndex];
      if (!selected) return;
      event.preventDefault();
      selected.click();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const nextIndex = recentProjectNavigationIndex(this.popupSelectionIndex, items.length, event.key);
    if (nextIndex === null) return;
    event.preventDefault();
    this.selectPopupResult(nextIndex, true);
  }

  private popupResultItems(): HTMLButtonElement[] {
    return this.popupList
      ? [...this.popupList.querySelectorAll<HTMLButtonElement>(".recent-projects-list-item")]
      : [];
  }

  private selectPopupResult(index: number, scrollIntoView: boolean): void {
    const items = this.popupResultItems();
    if (!items.length) return;
    this.popupSelectionIndex = Math.max(0, Math.min(index, items.length - 1));
    items.forEach((item, itemIndex) => {
      const selected = itemIndex === this.popupSelectionIndex;
      item.classList.toggle("keyboard-selected", selected);
      item.setAttribute("aria-selected", String(selected));
    });
    const selected = items[this.popupSelectionIndex];
    this.popupSearch?.setAttribute("aria-activedescendant", selected.id);
    if (scrollIntoView) selected.scrollIntoView({ block: "nearest" });
  }

  private createWelcomeItem(path: string, shortcut: string): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "welcome-item recent-project-item";
    item.title = path;
    item.append(
      this.icon("folder", "welcome-item-icon"),
      this.text(projectName(path), "welcome-item-text"),
      this.text(shortcut, "welcome-item-hotkey")
    );
    return item;
  }

  private icon(name: "folder" | "list", className: string): HTMLSpanElement {
    const icon = document.createElement("span");
    icon.className = className;
    icon.appendChild(createAppIcon(name, { size: 18 }));
    return icon;
  }

  private text(value: string, className: string): HTMLSpanElement {
    const element = document.createElement("span");
    element.className = className;
    element.textContent = value;
    return element;
  }
}

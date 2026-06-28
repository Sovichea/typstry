const storageKey = "typstry-recent-projects";

export class RecentProjectsController {
  constructor(private readonly onOpen: (path: string) => void | Promise<void>) {}

  public initialize(): void {
    this.render();
  }

  public add(path: string): void {
    const recent = [path, ...this.read().filter(item => item !== path)].slice(0, 5);
    localStorage.setItem(storageKey, JSON.stringify(recent));
    this.render();
  }

  private read(): string[] {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) || "[]");
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  private render(): void {
    const section = document.querySelectorAll<HTMLElement>(".welcome-section")[1];
    if (!section) return;
    section.replaceChildren();
    const title = document.createElement("div");
    title.className = "welcome-section-title";
    title.textContent = "RECENT PROJECTS";
    section.appendChild(title);

    const projects = this.read();
    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "welcome-empty";
      empty.textContent = "No recent projects";
      section.appendChild(empty);
      return;
    }

    projects.forEach((path, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "welcome-item recent-project-item";
      const icon = document.createElement("span");
      icon.className = "welcome-item-icon";
      icon.textContent = "📁";
      const text = document.createElement("span");
      text.className = "welcome-item-text";
      text.textContent = path.split(/[/\\]/).pop() || path;
      text.title = path;
      const hotkey = document.createElement("span");
      hotkey.className = "welcome-item-hotkey";
      hotkey.textContent = `Ctrl-${index + 1}`;
      item.append(icon, text, hotkey);
      item.addEventListener("click", () => { void this.onOpen(path); });
      section.appendChild(item);
    });
  }
}

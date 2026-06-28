export type LogEntryKind = "error" | "warning" | "info" | "log" | "hint";

export type LogConsoleEntryInput = {
  kind: LogEntryKind;
  message: string;
  source: string;
  filePath?: string;
  fileName?: string;
  line?: number;
  column?: number;
};

type LogConsoleEntry = LogConsoleEntryInput & {
  id: number;
  timestamp: Date;
};

export class LogConsoleController {
  private nextEntryId = 1;
  private diagnostics: LogConsoleEntry[] = [];
  private logs: LogConsoleEntry[] = [];
  private visible = false;
  private readonly console = document.getElementById("log-console")!;
  private readonly body = document.getElementById("log-console-body")!;
  private readonly toggleButton = document.getElementById("log-console-toggle") as HTMLButtonElement;
  private readonly closeButton = document.getElementById("log-console-close") as HTMLButtonElement;
  private readonly count = document.getElementById("diagnostic-count")!;

  constructor(private readonly onNavigate: (entry: LogConsoleEntryInput) => void | Promise<void>) {}

  public initialize(): void {
    this.toggleButton.addEventListener("click", () => this.toggle());
    this.closeButton.addEventListener("click", () => this.setVisible(false));
    this.render();
    this.setVisible(false);
  }

  public setDiagnostics(entries: LogConsoleEntryInput[]): void {
    this.diagnostics = entries.map(entry => this.createEntry(entry));
    this.render();
  }

  public appendLog(entry: LogConsoleEntryInput): void {
    this.logs.unshift(this.createEntry(entry));
    this.logs = this.logs.slice(0, 100);
    this.render();
  }

  public clearDiagnostics(): void {
    this.diagnostics = [];
    this.render();
  }

  public clearLogs(): void {
    this.logs = [];
    this.render();
  }

  public toggle(): void {
    this.setVisible(!this.visible);
  }

  public setVisible(visible: boolean): void {
    this.visible = visible;
    this.console.classList.toggle("hidden", !visible);
    document.getElementById("log-console-resizer")?.classList.toggle("hidden", !visible);
    this.updateCount();
  }

  private createEntry(entry: LogConsoleEntryInput): LogConsoleEntry {
    return { ...entry, id: this.nextEntryId++, timestamp: new Date() };
  }

  private render(): void {
    this.updateCount();
    this.body.replaceChildren();
    const entries = [...this.diagnostics, ...this.logs];
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "log-console-empty";
      empty.textContent = "No problems";
      this.body.appendChild(empty);
      return;
    }

    const groups = new Map<string, LogConsoleEntry[]>();
    for (const entry of entries) {
      const key = entry.filePath ?? entry.source ?? "Other";
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    for (const [key, group] of groups) this.body.appendChild(this.createGroup(key, group));
  }

  private createGroup(groupKey: string, entries: LogConsoleEntry[]): HTMLElement {
    const container = document.createElement("div");
    container.className = "log-group";
    const header = document.createElement("button");
    header.className = "log-group-header";
    header.type = "button";

    const first = entries[0];
    const fileName = first.fileName ?? groupKey;
    const directory = first.filePath ? this.dirname(first.filePath) : "";
    const name = document.createElement("span");
    name.className = "log-group-filename";
    name.textContent = fileName;
    const directoryName = document.createElement("span");
    directoryName.className = "log-group-dirname";
    directoryName.textContent = directory;
    const count = document.createElement("span");
    count.className = "log-group-count";
    count.textContent = String(entries.length);
    header.append(name, directoryName, count);

    const items = document.createElement("div");
    items.className = "log-group-items";
    for (const entry of entries) items.appendChild(this.createItem(entry));
    header.addEventListener("click", () => items.classList.toggle("hidden"));
    container.append(header, items);
    return container;
  }

  private createItem(entry: LogConsoleEntry): HTMLElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `log-entry log-entry-${entry.kind}`;
    const icon = document.createElement("span");
    icon.className = "log-entry-icon";
    icon.textContent = entry.kind === "error" ? "⊗" : entry.kind === "warning" ? "⚠" : "ℹ";
    const message = document.createElement("span");
    message.className = "log-entry-message";
    message.textContent = entry.message;
    const source = document.createElement("span");
    source.className = "log-entry-source";
    source.textContent = entry.source ? `typst(${entry.source})` : "";
    const location = document.createElement("span");
    location.className = "log-entry-position";
    if (entry.line) location.textContent = `[Ln ${entry.line}, Col ${entry.column ?? 1}]`;
    item.append(icon, message, source, location);
    item.addEventListener("click", () => { void this.onNavigate(entry); });
    return item;
  }

  private updateCount(): void {
    const errors = this.diagnostics.filter(entry => entry.kind === "error").length;
    const warnings = this.diagnostics.filter(entry => entry.kind === "warning").length;
    const total = this.diagnostics.length;
    this.count.textContent = total > 99 ? "99+" : String(total);
    this.toggleButton.dataset.state = errors ? "error" : warnings ? "warning" : "ok";
    this.toggleButton.setAttribute("aria-expanded", String(this.visible));
    this.toggleButton.setAttribute("aria-label", `${this.visible ? "Hide" : "Show"} log console, ${total} problem${total === 1 ? "" : "s"}`);
  }

  private dirname(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    return lastSlash > 0 ? normalized.slice(0, lastSlash) : "";
  }
}

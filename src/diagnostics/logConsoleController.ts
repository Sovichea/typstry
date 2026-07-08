import { createAppIcon } from "../ui/icons";

export type LogEntryKind = "error" | "warning" | "info" | "log" | "hint";
export type LogEntryChannel = "lsp" | "spellcheck" | "dev";
type LogConsoleTab = "all" | LogEntryChannel;

export type LogConsoleEntryInput = {
  kind: LogEntryKind;
  message: string;
  source: string;
  filePath?: string;
  fileName?: string;
  line?: number;
  column?: number;
  offset?: number;
  toOffset?: number;
  channel?: LogEntryChannel;
  counted?: boolean;
};

type LogConsoleEntry = LogConsoleEntryInput & {
  id: number;
  timestamp: Date;
};

export function duplicatesStructuredDiagnostic(
  entry: Pick<LogConsoleEntryInput, "channel" | "message">,
  diagnostics: readonly Pick<LogConsoleEntryInput, "message">[]
): boolean {
  if (entry.channel === "dev") return false;
  const message = canonicalDiagnosticMessage(entry.message);
  return message.length > 0 && diagnostics.some(
    diagnostic => canonicalDiagnosticMessage(diagnostic.message) === message
  );
}

function canonicalDiagnosticMessage(message: string): string {
  let msg = message
    .normalize("NFKC")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // strip ANSI escape codes
    .replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();

  // Normalize path-like components to just their last components (basenames)
  // to avoid duplication due to absolute cache path vs original workspace path mismatches
  msg = msg.split(" ").map(word => {
    if (word.includes("/") || word.includes("\\")) {
      const lastSlash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
      return word.slice(lastSlash + 1);
    }
    return word;
  }).join(" ");

  msg = msg.toLowerCase();

  // Strip prefixes
  let oldMsg;
  do {
    oldMsg = msg;
    msg = msg
      .replace(/^(?:error|warning|info|hint|typst|tinymist|problem|log)[:\s\-]+/g, "")
      .replace(/^\[(?:error|warning|info|hint|typst|tinymist|problem|log)\][:\s\-]*/g, "")
      .trim();
  } while (msg !== oldMsg);

  // Strip trailing period/colon/brackets/whitespaces
  msg = msg.replace(/[.:\s\-\]\[]+$/, "");

  return msg;
}

export class LogConsoleController {
  private nextEntryId = 1;
  private diagnostics: LogConsoleEntry[] = [];
  private diagnosticsByFile = new Map<string, LogConsoleEntry[]>();
  private spellcheckIssues: LogConsoleEntry[] = [];
  private logs: LogConsoleEntry[] = [];
  private activeTab: LogConsoleTab = "all";
  private visible = false;
  private readonly console = document.getElementById("log-console")!;
  private readonly body = document.getElementById("log-console-body")!;
  private readonly toggleButton = document.getElementById("log-console-toggle") as HTMLButtonElement;
  private readonly closeButton = document.getElementById("log-console-close") as HTMLButtonElement;
  private readonly errorCount = document.getElementById("diagnostic-error-count")!;
  private readonly warningCount = document.getElementById("diagnostic-warning-count")!;
  private readonly tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-log-console-tab]")];

  constructor(private readonly onNavigate: (entry: LogConsoleEntryInput) => void | Promise<void>) {}

  public initialize(): void {
    this.toggleButton.addEventListener("click", () => this.toggle());
    this.closeButton.addEventListener("click", () => this.setVisible(false));
    for (const tab of this.tabs) {
      tab.addEventListener("click", () => {
        this.activeTab = tab.dataset.logConsoleTab as LogConsoleTab;
        this.render();
      });
    }
    this.render();
    this.setVisible(false);
  }

  public getErrorCount(): number {
    return this.diagnostics.filter(entry => entry.kind === "error").length;
  }

  public setDiagnostics(filePath: string, entries: LogConsoleEntryInput[]): void {
    const filtered = entries.filter(entry => entry.source !== "preview" && entry.source !== "preview iframe" && entry.source !== "inverse sync");
    // Filter out duplicates in incoming diagnostics
    const seen = new Set<string>();
    const uniqueEntries: LogConsoleEntryInput[] = [];
    for (const entry of filtered) {
      const key = `${entry.filePath}:${entry.line}:${entry.column}:${canonicalDiagnosticMessage(entry.message)}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueEntries.push(entry);
      }
    }

    const mappedEntries = uniqueEntries.map(entry => this.createEntry({ ...entry, channel: "lsp" }));
    const fileKey = filePath.toLowerCase();
    if (mappedEntries.length > 0) {
      this.diagnosticsByFile.set(fileKey, mappedEntries);
    } else {
      this.diagnosticsByFile.delete(fileKey);
    }

    this.diagnostics = Array.from(this.diagnosticsByFile.values()).flat();
    this.logs = this.logs.filter(log => !duplicatesStructuredDiagnostic(log, this.diagnostics));
    this.render();
  }

  public setSpellcheckIssues(entries: LogConsoleEntryInput[]): void {
    this.spellcheckIssues = entries.map(entry => this.createEntry({ ...entry, channel: "spellcheck" }));
    this.render();
  }

  public appendLog(entry: LogConsoleEntryInput): void {
    if (entry.channel !== "dev"
      && (entry.source === "preview" || entry.source === "preview iframe" || entry.source === "inverse sync")) return;
    const log = this.createEntry({ ...entry, channel: entry.channel ?? "lsp" });
    if (duplicatesStructuredDiagnostic(log, this.diagnostics)) return;

    // Filter duplicates within current log entries
    const canonical = canonicalDiagnosticMessage(log.message);
    if (this.logs.some(existing => canonicalDiagnosticMessage(existing.message) === canonical)) {
      return;
    }

    this.logs.unshift(log);
    this.logs = this.logs.slice(0, 100);
    this.render();
  }

  public clearDiagnostics(): void {
    this.diagnosticsByFile.clear();
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
    for (const tab of this.tabs) {
      const selected = tab.dataset.logConsoleTab === this.activeTab;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
    }
    const entries = this.filteredEntries();
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

  private filteredEntries(): LogConsoleEntry[] {
    const structured = this.diagnostics.filter(entry => entry.filePath && entry.line !== undefined);
    const visibleLogs = this.logs.filter(log =>
      (log.filePath && log.line !== undefined)
      || !duplicatesStructuredDiagnostic(log, structured)
    );
    const all = [...this.diagnostics, ...this.spellcheckIssues, ...visibleLogs];
    if (this.activeTab === "all") return all;
    return all.filter(entry => entry.channel === this.activeTab);
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
    icon.appendChild(createAppIcon(
      entry.kind === "error" ? "circleX" : entry.kind === "warning" ? "triangleAlert" : "info",
      { size: 14 }
    ));
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
    const spellcheck = this.spellcheckIssues.filter(entry => entry.counted !== false).length;
    const problems = total + spellcheck;
    const totalWarnings = warnings + spellcheck;

    this.errorCount.textContent = errors > 99 ? "99+" : String(errors);
    this.warningCount.textContent = totalWarnings > 99 ? "99+" : String(totalWarnings);

    // Toggle active state classes on parent items
    const errorItem = this.errorCount.closest(".status-count-item");
    if (errorItem) {
      errorItem.classList.toggle("active", errors > 0);
    }
    const warningItem = this.warningCount.closest(".status-count-item");
    if (warningItem) {
      warningItem.classList.toggle("active", totalWarnings > 0);
    }

    this.setTabCount("all", problems);
    this.setTabCount("lsp", total);
    this.setTabCount("spellcheck", spellcheck);
    this.setTabCount("dev", this.logs.filter(entry => entry.channel === "dev").length);
    this.toggleButton.dataset.state = errors ? "error" : totalWarnings ? "warning" : "ok";
    this.toggleButton.setAttribute("aria-expanded", String(this.visible));
    this.toggleButton.setAttribute("aria-label", `${this.visible ? "Hide" : "Show"} log console, ${errors} error${errors === 1 ? "" : "s"}, ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}`);
  }

  private setTabCount(tab: LogConsoleTab, value: number): void {
    const count = document.querySelector<HTMLElement>(`[data-log-console-count="${tab}"]`);
    if (count) count.textContent = value > 99 ? "99+" : String(value);
  }

  private dirname(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    return lastSlash > 0 ? normalized.slice(0, lastSlash) : "";
  }
}

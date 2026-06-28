import type { PreviewDocumentPosition, TinymistDocumentOutlineItem } from "../compiler/lsp";

export type DocumentHeading = {
  id: string;
  level: number;
  title: string;
  from: number;
  textFrom: number;
  to: number;
  line: number;
  previewPosition?: PreviewDocumentPosition;
  children: DocumentHeading[];
};

function updateBlockCommentDepth(line: string, initialDepth: number): number {
  let depth = initialDepth;
  for (let index = 0; index < line.length - 1; index++) {
    const pair = line.slice(index, index + 2);
    if (pair === "/*") {
      depth++;
      index++;
    } else if (pair === "*/" && depth > 0) {
      depth--;
      index++;
    }
  }
  return depth;
}

function displayTitle(sourceTitle: string): string {
  const withoutLabel = sourceTitle.replace(/\s*<[\p{L}\p{N}_:.-]+>\s*$/u, "").trim();
  return withoutLabel || "Untitled heading";
}

export function parseDocumentOutline(source: string): DocumentHeading[] {
  const flat: DocumentHeading[] = [];
  const occurrences = new Map<string, number>();
  let blockCommentDepth = 0;
  let rawFenceLength = 0;
  let lineStart = 0;
  let lineNumber = 1;

  while (lineStart <= source.length) {
    const newline = source.indexOf("\n", lineStart);
    const rawLineEnd = newline === -1 ? source.length : newline;
    const lineEnd = rawLineEnd > lineStart && source[rawLineEnd - 1] === "\r"
      ? rawLineEnd - 1
      : rawLineEnd;
    const line = source.slice(lineStart, lineEnd);
    const trimmed = line.trimStart();

    if (rawFenceLength > 0) {
      const closingFence = trimmed.match(/^(`{3,})\s*$/);
      if (closingFence && closingFence[1].length >= rawFenceLength) rawFenceLength = 0;
    } else if (blockCommentDepth > 0) {
      blockCommentDepth = updateBlockCommentDepth(line, blockCommentDepth);
    } else {
      const rawFence = trimmed.match(/^(`{3,})(.*)$/);
      if (rawFence) {
        if (!rawFence[2].includes(rawFence[1])) rawFenceLength = rawFence[1].length;
      } else if (trimmed.startsWith("//")) {
        // A comment-only line cannot contain a document heading.
      } else if (trimmed.startsWith("/*")) {
        blockCommentDepth = updateBlockCommentDepth(line, blockCommentDepth);
      } else {
        const match = line.match(/^([ \t]*)(=+)([ \t]+)(.+?)\s*$/);
        if (match) {
          const level = match[2].length;
          const title = displayTitle(match[4]);
          const signature = `${level}:${title}`;
          const occurrence = (occurrences.get(signature) ?? 0) + 1;
          occurrences.set(signature, occurrence);
          const markerLength = match[1].length + match[2].length + match[3].length;
          flat.push({
            id: `${signature}:${occurrence}`,
            level,
            title,
            from: lineStart + match[1].length,
            textFrom: lineStart + markerLength,
            to: lineEnd,
            line: lineNumber,
            children: []
          });
        }
        blockCommentDepth = updateBlockCommentDepth(line, blockCommentDepth);
      }
    }

    if (newline === -1) break;
    lineStart = newline + 1;
    lineNumber++;
  }

  const roots: DocumentHeading[] = [];
  const parents: DocumentHeading[] = [];
  for (const heading of flat) {
    while (parents.length && parents[parents.length - 1].level >= heading.level) parents.pop();
    const parent = parents[parents.length - 1];
    if (parent) parent.children.push(heading);
    else roots.push(heading);
    parents.push(heading);
  }
  return roots;
}

function flattenHeadings(headings: readonly DocumentHeading[]): DocumentHeading[] {
  return headings.flatMap(heading => [heading, ...flattenHeadings(heading.children)]);
}

function flattenRenderedOutline(items: readonly TinymistDocumentOutlineItem[]): TinymistDocumentOutlineItem[] {
  return items.flatMap(item => [item, ...flattenRenderedOutline(item.children)]);
}

function comparableTitle(title: string): string {
  return title
    .replace(/^\s*\d+(?:\.\d+)*[.:]?\s+/u, "")
    .replace(/[\s*_`~#]+/g, "")
    .toLocaleLowerCase();
}

export class DocumentOutlineController {
  private headings: DocumentHeading[] = [];
  private flatHeadings: DocumentHeading[] = [];
  private readonly collapsed = new Set<string>();
  private cursor = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly section: HTMLElement,
    private readonly onNavigate: (heading: DocumentHeading) => void
  ) {}

  public initialize(): void {
    const toggle = document.getElementById("document-outline-toggle");
    toggle?.addEventListener("click", () => {
      const isCollapsed = this.section.classList.toggle("collapsed");
      toggle.setAttribute("aria-expanded", String(!isCollapsed));
    });
    this.render();
  }

  public update(path: string | null, source: string): void {
    this.headings = path?.toLowerCase().endsWith(".typ") ? parseDocumentOutline(source) : [];
    this.flatHeadings = flattenHeadings(this.headings);
    const validIds = new Set(this.flatHeadings.map(heading => heading.id));
    for (const id of this.collapsed) {
      if (!validIds.has(id)) this.collapsed.delete(id);
    }
    this.render();
    this.setCursorPosition(this.cursor);
  }

  public clear(): void {
    this.headings = [];
    this.flatHeadings = [];
    this.cursor = 0;
    this.collapsed.clear();
    this.render();
  }

  public setCursorPosition(cursor: number): void {
    this.cursor = cursor;
    let active: DocumentHeading | undefined;
    for (const heading of this.flatHeadings) {
      if (heading.from > cursor) break;
      active = heading;
    }
    this.container.querySelectorAll<HTMLElement>(".outline-item.active").forEach(item => {
      item.classList.remove("active");
    });
    if (active) {
      const row = Array.from(this.container.querySelectorAll<HTMLElement>(".outline-item"))
        .find(item => item.dataset.outlineId === active.id);
      row?.classList.add("active");
      row?.scrollIntoView({ block: "nearest" });
    }
  }

  public findHeading(id: string): DocumentHeading | undefined {
    return this.flatHeadings.find(heading => heading.id === id);
  }

  public previewPositionAt(cursor: number): PreviewDocumentPosition | undefined {
    let position: PreviewDocumentPosition | undefined;
    for (const heading of this.flatHeadings) {
      if (heading.from > cursor) break;
      if (heading.previewPosition) position = heading.previewPosition;
    }
    return position;
  }

  public updatePreviewPositions(items: readonly TinymistDocumentOutlineItem[]): void {
    const rendered = flattenRenderedOutline(items);
    const claimed = new Set<number>();
    for (const heading of this.flatHeadings) {
      const title = comparableTitle(heading.title);
      const renderedIndex = rendered.findIndex((item, index) => {
        if (claimed.has(index)) return false;
        const renderedTitle = comparableTitle(item.title);
        return renderedTitle === title || renderedTitle.endsWith(title);
      });
      if (renderedIndex === -1) continue;
      claimed.add(renderedIndex);
      heading.previewPosition = rendered[renderedIndex].position;
    }
  }

  private render(): void {
    const count = document.getElementById("document-outline-count");
    if (count) count.textContent = String(this.flatHeadings.length);
    if (!this.headings.length) {
      const empty = document.createElement("div");
      empty.className = "outline-empty";
      empty.textContent = "No headings in the active document.";
      this.container.replaceChildren(empty);
      return;
    }
    this.container.replaceChildren(this.renderLevel(this.headings));
  }

  private renderLevel(headings: readonly DocumentHeading[]): HTMLUListElement {
    const list = document.createElement("ul");
    list.className = "outline-list";
    for (const heading of headings) {
      const item = document.createElement("li");
      item.className = "outline-node";
      const row = document.createElement("div");
      row.className = "outline-item";
      row.dataset.outlineId = heading.id;
      row.title = `${heading.title} (line ${heading.line})`;

      const disclosure = document.createElement("button");
      disclosure.type = "button";
      disclosure.className = "outline-disclosure";
      if (heading.children.length) {
        const isCollapsed = this.collapsed.has(heading.id);
        disclosure.textContent = "▾";
        disclosure.classList.toggle("collapsed", isCollapsed);
        disclosure.setAttribute("aria-label", `${isCollapsed ? "Expand" : "Collapse"} ${heading.title}`);
        disclosure.setAttribute("aria-expanded", String(!isCollapsed));
        disclosure.addEventListener("click", event => {
          event.stopPropagation();
          if (this.collapsed.has(heading.id)) this.collapsed.delete(heading.id);
          else this.collapsed.add(heading.id);
          this.render();
          this.setCursorPosition(this.cursor);
        });
      } else {
        disclosure.classList.add("placeholder");
        disclosure.tabIndex = -1;
        disclosure.disabled = true;
        disclosure.setAttribute("aria-hidden", "true");
      }

      const label = document.createElement("button");
      label.type = "button";
      label.className = "outline-label";
      label.textContent = heading.title;
      label.addEventListener("click", () => this.onNavigate(heading));
      row.append(disclosure, label);
      item.appendChild(row);
      if (heading.children.length) {
        const children = this.renderLevel(heading.children);
        children.classList.toggle("hidden", this.collapsed.has(heading.id));
        item.appendChild(children);
      }
      list.appendChild(item);
    }
    return list;
  }
}

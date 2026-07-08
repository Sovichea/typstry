import { EditorView } from "@codemirror/view";
import type { LspSourcePosition, PreviewDocumentPosition, TinymistLspClient } from "../compiler/lsp";
import type { PreviewTextPoint } from "./previewFrame";
import { findPreviewTextMatchInSource, findPreviewTextMatchInSourceLine } from "./sourceHighlight";

export type PreviewSyncDependencies = {
  getEditor: () => EditorView | undefined;
  getClient: () => TinymistLspClient | undefined;
  getActiveFilePath: () => string | null;
  getPreviewRootPath: () => string | null;
  getPreviewTaskId: () => string | null;
  isReady: () => boolean;
  isEnabled: () => boolean;
  handleForwardPosition?: (path: string, cursor: number) => Promise<boolean>;
  mapForwardPosition?: (path: string, cursor: number) => Promise<{ filepath: string; line: number; character: number } | null>;
};

export type InverseSyncResult = {
  cursor: number;
  refined: boolean;
  reason: "refined" | "no-click" | "stale-click" | "empty-click" | "no-editor" | "no-source-match";
  fallback: number;
  previewTextLength?: number;
  previewOffset?: number;
  sourceLine?: number;
  sourceOffset?: number;
  clickedTextSample?: string;
};

export class PreviewSyncController {
  private forwardTimer: number | null = null;
  private forwardGeneration = 0;
  private lastForwardTarget: { key: string; timestamp: number } | null = null;
  private pendingTextClick: (PreviewTextPoint & { timestamp: number }) | null = null;

  constructor(
    private readonly dependencies: PreviewSyncDependencies
  ) {}

  public recordTextClick(point: PreviewTextPoint): void {
    this.pendingTextClick = { ...point, timestamp: Date.now() };
  }

  public navigateFromTextClick(point: PreviewTextPoint): boolean {
    this.recordTextClick(point);
    const editor = this.dependencies.getEditor();
    if (!editor || !point.text.trim()) return false;
    const preferred = editor.state.selection.main.head;
    const match = findPreviewTextMatchInSource(editor.state.doc.toString(), point.text, point.offset, preferred);
    if (!match) return false;
    this.suppressOnce();
    editor.dispatch({
      selection: { anchor: match.sourceOffset },
      effects: EditorView.scrollIntoView(match.sourceOffset, { y: "center" })
    });
    editor.focus();
    return true;
  }

  public hasRecentTextClick(maxAgeMs = 1500): boolean {
    return this.pendingTextClick !== null && Date.now() - this.pendingTextClick.timestamp <= maxAgeMs;
  }

  public schedule(delayMs: number): void {
    if (!this.canSync()) return;
    this.clearForward();
    const generation = ++this.forwardGeneration;
    this.forwardTimer = window.setTimeout(() => {
      this.forwardTimer = null;
      if (generation !== this.forwardGeneration) return;
      const cursor = this.dependencies.getEditor()?.state.selection.main.head;
      if (cursor !== undefined) void this.renderAtCursor(cursor);
    }, delayMs);
  }

  public async renderAtCursor(cursor: number): Promise<void> {
    const editor = this.dependencies.getEditor();
    const path = this.dependencies.getActiveFilePath();
    if (!editor || !path || !this.dependencies.isReady() || !this.dependencies.isEnabled()) return;

    this.clearForward();
    await this.navigateToCursor(cursor, ++this.forwardGeneration);
  }

  public async navigateToCursor(cursor: number, generation = ++this.forwardGeneration): Promise<void> {
    const editor = this.dependencies.getEditor();
    const path = this.dependencies.getActiveFilePath();
    if (!editor || !path || !this.dependencies.isReady() || !this.dependencies.isEnabled()) return;

    if (this.dependencies.handleForwardPosition) {
      const handled = await this.dependencies.handleForwardPosition(path, cursor);
      if (generation !== this.forwardGeneration) return;
      if (handled) return;
    }

    const client = this.dependencies.getClient();
    const taskId = this.dependencies.getPreviewTaskId();
    if (!client || !this.dependencies.getPreviewRootPath() || !taskId) return;

    if (this.dependencies.mapForwardPosition) {
      const mapped = await this.dependencies.mapForwardPosition(path, cursor);
      if (generation !== this.forwardGeneration) return;
      if (mapped) {
        if (this.isDuplicateForwardTarget(taskId, mapped.filepath, mapped.line, mapped.character)) return;
        await client.scrollPreview(taskId, {
          event: "panelScrollTo",
          filepath: mapped.filepath,
          line: mapped.line,
          character: mapped.character
        });
        return;
      }
    }

    const position = Math.max(0, Math.min(cursor, editor.state.doc.length));
    const line = editor.state.doc.lineAt(position);
    const character = client.lspCharacterFromStringOffset(line.text, position - line.from);
    if (generation !== this.forwardGeneration) return;
    if (this.isDuplicateForwardTarget(taskId, path, line.number - 1, character)) return;
    await client.scrollPreview(taskId, {
      event: "panelScrollTo",
      filepath: path,
      line: line.number - 1,
      character
    });
  }

  public async navigateToPosition(position: PreviewDocumentPosition): Promise<void> {
    const client = this.dependencies.getClient();
    const taskId = this.dependencies.getPreviewTaskId();
    if (!client || !taskId || !this.dependencies.getPreviewRootPath() || !this.dependencies.isReady()) return;
    await client.scrollPreview(taskId, {
      event: "panelScrollByPosition",
      position
    });
  }

  public suppressOnce(): void {
    this.clearForward();
    this.forwardGeneration++;
  }

  public clearForward(): void {
    if (this.forwardTimer) window.clearTimeout(this.forwardTimer);
    this.forwardTimer = null;
  }

  public reset(): void {
    this.clearForward();
    this.forwardGeneration++;
    this.lastForwardTarget = null;
    this.pendingTextClick = null;
  }

  public mapInversePosition(position: LspSourcePosition, fallback: number): InverseSyncResult {
    return this.refineFromTextClick(position, fallback);
  }

  private canSync(): boolean {
    return this.dependencies.isEnabled()
      && !!this.dependencies.getActiveFilePath()
      && !!this.dependencies.getPreviewRootPath()
      && this.dependencies.isReady()
      && (!!this.dependencies.handleForwardPosition
        || (!!this.dependencies.getPreviewTaskId() && !!this.dependencies.getClient()));
  }

  private isDuplicateForwardTarget(taskId: string, filepath: string, line: number, character: number): boolean {
    const now = Date.now();
    const key = `${taskId}\u0000${filepath}\u0000${line}\u0000${character}`;
    if (this.lastForwardTarget?.key === key && now - this.lastForwardTarget.timestamp < 500) {
      return true;
    }
    this.lastForwardTarget = { key, timestamp: now };
    return false;
  }

  private refineFromTextClick(position: LspSourcePosition, fallback: number): InverseSyncResult {
    const click = this.pendingTextClick;
    this.pendingTextClick = null;
    const editor = this.dependencies.getEditor();
    if (!editor) return { cursor: fallback, refined: false, reason: "no-editor", fallback };
    if (!click) return { cursor: fallback, refined: false, reason: "no-click", fallback };
    if (Date.now() - click.timestamp > 1500) {
      return this.inverseFallback("stale-click", fallback, click, position);
    }
    if (!click.text.trim()) {
      return this.inverseFallback("empty-click", fallback, click, position);
    }
    const doc = editor.state.doc;
    const line = doc.line(Math.max(1, Math.min(position.line + 1, doc.lines)));
    const match = findPreviewTextMatchInSourceLine(line.text, click.text, click.offset, Math.max(0, fallback - line.from));
    if (!match) return this.inverseFallback("no-source-match", fallback, click, position);
    const cursor = Math.max(line.from, Math.min(line.from + match.sourceOffset, line.to));
    return {
      cursor,
      refined: true,
      reason: "refined",
      fallback,
      previewTextLength: click.text.length,
      previewOffset: click.offset,
      sourceLine: position.line,
      sourceOffset: match.sourceOffset,
      clickedTextSample: sampleClickText(click.text, click.offset)
    };
  }

  private inverseFallback(
    reason: InverseSyncResult["reason"],
    fallback: number,
    click: PreviewTextPoint,
    position: LspSourcePosition
  ): InverseSyncResult {
    return {
      cursor: fallback,
      refined: false,
      reason,
      fallback,
      previewTextLength: click.text.length,
      previewOffset: click.offset,
      sourceLine: position.line,
      clickedTextSample: sampleClickText(click.text, click.offset)
    };
  }
}

function sampleClickText(text: string, offset: number): string {
  const start = Math.max(0, offset - 24);
  const end = Math.min(text.length, offset + 48);
  return text.slice(start, end).replace(/\s+/g, " ");
}

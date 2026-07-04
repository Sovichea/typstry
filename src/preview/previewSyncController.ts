import type { EditorView } from "@codemirror/view";
import type { LspSourcePosition, PreviewDocumentPosition, TinymistLspClient } from "../compiler/lsp";
import type { PreviewTextPoint } from "./previewFrame";
import { findPreviewTextMatchInSourceLine } from "./sourceHighlight";

export type PreviewSyncDependencies = {
  getEditor: () => EditorView | undefined;
  getClient: () => TinymistLspClient | undefined;
  getActiveFilePath: () => string | null;
  getPreviewRootPath: () => string | null;
  getPreviewTaskId: () => string | null;
  isReady: () => boolean;
  isEnabled: () => boolean;
  mapForwardPosition?: (path: string, cursor: number) => Promise<{ filepath: string; line: number; character: number } | null>;
};

export class PreviewSyncController {
  private forwardTimer: number | null = null;
  private pendingTextClick: (PreviewTextPoint & { timestamp: number }) | null = null;

  constructor(
    private readonly dependencies: PreviewSyncDependencies
  ) {}

  public recordTextClick(point: PreviewTextPoint): void {
    this.pendingTextClick = { ...point, timestamp: Date.now() };
  }

  public schedule(delayMs: number): void {
    if (!this.canSync()) return;
    this.clearForward();
    this.forwardTimer = window.setTimeout(() => {
      this.forwardTimer = null;
      const cursor = this.dependencies.getEditor()?.state.selection.main.head;
      if (cursor !== undefined) void this.renderAtCursor(cursor);
    }, delayMs);
  }

  public async renderAtCursor(cursor: number): Promise<void> {
    const editor = this.dependencies.getEditor();
    const client = this.dependencies.getClient();
    const path = this.dependencies.getActiveFilePath();
    if (!editor || !client || !path || !this.dependencies.getPreviewTaskId() || !this.dependencies.isReady()) return;

    this.clearForward();
    await this.navigateToCursor(cursor);
  }

  public async navigateToCursor(cursor: number): Promise<void> {
    const editor = this.dependencies.getEditor();
    const client = this.dependencies.getClient();
    const path = this.dependencies.getActiveFilePath();
    const taskId = this.dependencies.getPreviewTaskId();
    if (!editor || !client || !path || !this.dependencies.getPreviewRootPath() || !taskId || !this.dependencies.isReady()) return;

    if (this.dependencies.mapForwardPosition) {
      const mapped = await this.dependencies.mapForwardPosition(path, cursor);
      if (mapped) {
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
  }

  public clearForward(): void {
    if (this.forwardTimer) window.clearTimeout(this.forwardTimer);
    this.forwardTimer = null;
  }

  public reset(): void {
    this.clearForward();
    this.pendingTextClick = null;
  }

  public mapInversePosition(position: LspSourcePosition, fallback: number): number {
    return this.refineFromTextClick(position, fallback);
  }

  private canSync(): boolean {
    return this.dependencies.isEnabled()
      && !!this.dependencies.getActiveFilePath()
      && !!this.dependencies.getPreviewRootPath()
      && !!this.dependencies.getPreviewTaskId()
      && this.dependencies.isReady()
      && !!this.dependencies.getClient();
  }

  private refineFromTextClick(position: LspSourcePosition, fallback: number): number {
    const click = this.pendingTextClick;
    this.pendingTextClick = null;
    const editor = this.dependencies.getEditor();
    if (!editor || !click || Date.now() - click.timestamp > 1500 || !click.text.trim()) return fallback;
    const doc = editor.state.doc;
    const line = doc.line(Math.max(1, Math.min(position.line + 1, doc.lines)));
    const match = findPreviewTextMatchInSourceLine(line.text, click.text, click.offset);
    return match ? Math.max(line.from, Math.min(line.from + match.sourceOffset, line.to)) : fallback;
  }
}

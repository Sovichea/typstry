import type { EditorView } from "@codemirror/view";
import type { LspSourcePosition, TinymistLspClient } from "../compiler/lsp";
import { filePathToUri } from "../platform/paths";
import { PreviewFrame, type PreviewTextPoint } from "./previewFrame";
import {
  buildHighlightedPreviewSource,
  findPreviewTextMatchInSourceLine,
  originalOffsetFromHighlightedOffset,
  type PreviewHighlightMapping
} from "./sourceHighlight";

type RestoredDocument = { path: string; text: string; version: number };

export type PreviewSyncDependencies = {
  getEditor: () => EditorView | undefined;
  getClient: () => TinymistLspClient | undefined;
  getActiveFilePath: () => string | null;
  getPreviewRootPath: () => string | null;
  isReady: () => boolean;
  isEnabled: () => boolean;
  getHighlightDuration: () => number;
  nextPreviewVersion: () => number;
  restoreDocumentVersion: () => RestoredDocument | null;
};

export class PreviewSyncController {
  private forwardTimer: number | null = null;
  private pollTimer: number | null = null;
  private revertTimer: number | null = null;
  private suppressNextForwardSync = false;
  private mapping: PreviewHighlightMapping | null = null;
  private pendingTextClick: (PreviewTextPoint & { timestamp: number }) | null = null;
  private readonly previewOnlyVersions = new Set<number>();
  private diagnosticsSuppressedUntil = 0;

  constructor(
    private readonly frame: PreviewFrame,
    private readonly dependencies: PreviewSyncDependencies
  ) {}

  public recordTextClick(point: PreviewTextPoint): void {
    this.pendingTextClick = { ...point, timestamp: Date.now() };
  }

  public schedule(delayMs: number): void {
    if (!this.canSync()) return;
    if (this.suppressNextForwardSync) {
      this.suppressNextForwardSync = false;
      this.clearForward();
      return;
    }
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
    if (!editor || !client || !path || path !== this.dependencies.getPreviewRootPath() || !this.dependencies.isReady()) return;

    const highlight = buildHighlightedPreviewSource(
      editor.state.doc,
      cursor,
      (text, offset) => client.lspCharacterFromStringOffset(text, offset)
    );
    if (!highlight) {
      this.clearPoll();
      if (this.mapping) this.revertDocument();
      return;
    }

    this.mapping = highlight.mapping;
    const version = this.dependencies.nextPreviewVersion();
    this.previewOnlyVersions.add(version);
    if (this.previewOnlyVersions.size > 200) {
      const oldest = this.previewOnlyVersions.values().next().value;
      if (typeof oldest === "number") this.previewOnlyVersions.delete(oldest);
    }
    this.diagnosticsSuppressedUntil = Date.now() + this.dependencies.getHighlightDuration() + 2000;
    this.clearPoll();
    this.clearRevert();
    await client.notifyTextChange(filePathToUri(path), highlight.text, version);
    window.setTimeout(() => {
      if (this.dependencies.isReady() && this.dependencies.getActiveFilePath() === path) {
        void client.scrollPreview("default_preview", {
          event: "panelScrollTo",
          filepath: path,
          line: highlight.scrollLine,
          character: highlight.scrollCharacter
        });
      }
    }, 10);

    let attempts = 0;
    this.pollTimer = window.setInterval(() => {
      attempts++;
      try {
        if (this.frame.scrollToHighlight()) {
          this.clearPoll();
          this.scheduleRevert();
          return;
        }
      } catch {
        // Cross-origin frames are retried until timeout.
      }
      if (attempts >= 15) {
        this.clearPoll();
        this.revertDocument();
      }
    }, 100);
  }

  public suppressOnce(): void {
    this.suppressNextForwardSync = true;
    this.clearForward();
  }

  public clearForward(): void {
    if (this.forwardTimer) window.clearTimeout(this.forwardTimer);
    this.forwardTimer = null;
  }

  public reset(): void {
    this.clearForward();
    this.clearPoll();
    this.clearRevert();
    this.mapping = null;
    this.pendingTextClick = null;
    this.previewOnlyVersions.clear();
    this.diagnosticsSuppressedUntil = 0;
  }

  public clearMapping(): void {
    this.mapping = null;
  }

  public shouldIgnoreDiagnostics(version: number | undefined, latestDocumentVersion: number): boolean {
    if (typeof version === "number") {
      return this.previewOnlyVersions.has(version) || version < latestDocumentVersion;
    }
    return Date.now() < this.diagnosticsSuppressedUntil;
  }

  public shouldSuppressErrorLog(): boolean {
    return Date.now() < this.diagnosticsSuppressedUntil;
  }

  public mapInversePosition(position: LspSourcePosition, fallback: number): number {
    const editor = this.dependencies.getEditor();
    const client = this.dependencies.getClient();
    const mapping = this.mapping;
    let cursor = fallback;
    if (editor && client && mapping && position.line + 1 === mapping.lineNumber) {
      const highlightedOffset = client.stringOffsetFromLspCharacter(mapping.highlightedLineText, position.character ?? 0);
      const originalOffset = originalOffsetFromHighlightedOffset(mapping, highlightedOffset);
      const line = editor.state.doc.line(mapping.lineNumber);
      cursor = Math.max(line.from, Math.min(mapping.lineFrom + originalOffset, line.to));
    }
    return this.refineFromTextClick(position, cursor);
  }

  private canSync(): boolean {
    return this.dependencies.isEnabled()
      && !!this.dependencies.getActiveFilePath()
      && !!this.dependencies.getPreviewRootPath()
      && this.dependencies.isReady()
      && !!this.dependencies.getClient();
  }

  private scheduleRevert(): void {
    this.clearRevert();
    this.revertTimer = window.setTimeout(() => {
      this.revertTimer = null;
      this.revertDocument();
    }, this.dependencies.getHighlightDuration());
  }

  private revertDocument(): void {
    const restored = this.dependencies.restoreDocumentVersion();
    const client = this.dependencies.getClient();
    if (!restored || !client || !this.dependencies.isReady()) return;
    this.mapping = null;
    this.diagnosticsSuppressedUntil = Date.now() + 1000;
    void client.notifyTextChange(filePathToUri(restored.path), restored.text, restored.version);
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

  private clearPoll(): void {
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private clearRevert(): void {
    if (this.revertTimer) window.clearTimeout(this.revertTimer);
    this.revertTimer = null;
  }
}

import { StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import type { LanguageProviderCapabilities } from "../languageSupport";
import { editingPolicyRegistry } from "./editingPolicies/registry";

export type EditorToken = {
  provider: string;
  sourceFromUtf16: number;
  sourceToUtf16: number;
  sourceText: string;
  normalizedText: string;
  known: boolean;
  knownPrefix: boolean;
  hyphenated?: string;
};

export type AnalyzeResponse = {
  tokens: EditorToken[];
};

export type ProviderCapabilities = LanguageProviderCapabilities;

export type SpellingIssue = {
  provider: string;
  documentKey: string;
  revision: number;
  docIdentity: Text;
  from: number;
  to: number;
  sourceText: string;
  word: string;
  knownPrefix: boolean;
  ignored: boolean;
  synthetic?: boolean;
};

const setSpellingIssues = StateEffect.define<SpellingIssue[]>();
const spellingField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setSpellingIssues)) continue;
      const decorations = effect.value.map(issue => Decoration.mark({
        class: issue.ignored ? "cm-spelling-ignored" : "cm-spelling-unknown",
        attributes: { title: issue.ignored
          ? `${issue.word} is ignored but is not in the selected language dictionary`
          : `${issue.word} is not in the selected language dictionary` }
      }).range(issue.from, issue.to));
      return Decoration.set(decorations, true);
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field)
});

function expandRange(doc: Text, from: number, to: number, patterns: RegExp[]): { from: number, to: number } {
  const matchesAny = (char: string) => patterns.some(pat => pat.test(char));
  let newFrom = from;
  while (newFrom > 0 && matchesAny(doc.sliceString(newFrom - 1, newFrom))) {
    newFrom--;
  }
  while (newFrom > 0 && !matchesAny(doc.sliceString(newFrom - 1, newFrom)) && doc.sliceString(newFrom - 1, newFrom) !== "\n") {
    newFrom--;
  }
  while (newFrom > 0 && matchesAny(doc.sliceString(newFrom - 1, newFrom))) {
    newFrom--;
  }
  
  let newTo = to;
  const docLength = doc.length;
  while (newTo < docLength && matchesAny(doc.sliceString(newTo, newTo + 1))) {
    newTo++;
  }
  while (newTo < docLength && !matchesAny(doc.sliceString(newTo, newTo + 1)) && doc.sliceString(newTo, newTo + 1) !== "\n") {
    newTo++;
  }
  while (newTo < docLength && matchesAny(doc.sliceString(newTo, newTo + 1))) {
    newTo++;
  }
  
  const lineStart = doc.lineAt(from).from;
  const lineEnd = doc.lineAt(to).to;
  return {
    from: Math.max(lineStart, newFrom),
    to: Math.min(lineEnd, newTo)
  };
}

function coalesceRanges(ranges: { from: number; to: number }[]): { from: number; to: number }[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const coalesced: { from: number; to: number }[] = [];
  for (const r of sorted) {
    if (coalesced.length === 0) {
      coalesced.push(r);
    } else {
      const last = coalesced[coalesced.length - 1];
      if (r.from <= last.to) {
        last.to = Math.max(last.to, r.to);
      } else {
        coalesced.push(r);
      }
    }
  }
  return coalesced;
}

export function isTypstProseRange(state: EditorState, from: number, to: number): boolean {
  if (from < 0 || to <= from || to > state.doc.length) return false;
  if (typeof (state as { field?: unknown }).field !== "function") return true;
  const tree = syntaxTree(state);
  const proseToken = (position: number, bias: -1 | 1): boolean => {
    const names = new Set(tree.resolveInner(position, bias).name.split(" "));
    return names.has("content") || names.has("heading") || names.has("term");
  };
  return proseToken(from, 1) && proseToken(to, -1);
}

export class SpellcheckController {
  private enabled = true;
  private timer: number | null = null;
  private revision = 0;
  private documentKey = "";
  private suggestionRequestGeneration = 0;
  private visibilityRefreshGeneration = 0;
  private completionActive = false;
  private activeTypingPosition: number | null = null;
  private readonly warnedFailures = new Set<string>();
  private userDictionary = new Set<string>();
  private ignoredWords = new Set<string>();
  public issues: SpellingIssue[] = [];
  private suggestionCache = new Map<string, string[]>();
  private providers: ProviderCapabilities[] = [];
  private enabledProviderIds: Set<string> | null = null;
  
  private pendingRanges: { from: number; to: number }[] = [];
  private activeRequest: { documentKey: string; revision: number; docIdentity: Text } | null = null;
  private queuedRequest: { ranges: { from: number; to: number }[] } | null = null;

  constructor(
    private readonly getEditor: () => EditorView,
    private readonly onIssuesChanged?: (issues: readonly SpellingIssue[]) => void
  ) {}

  public async initialize(): Promise<void> {
    try {
      this.providers = await invoke<ProviderCapabilities[]>("get_provider_capabilities");
    } catch (error) {
      console.error("Failed to fetch provider capabilities:", error);
    }
  }

  public getProviders(): ProviderCapabilities[] {
    if (this.enabledProviderIds === null) return this.providers;
    return this.providers.filter(provider => this.enabledProviderIds?.has(provider.id));
  }

  public getAllProviders(): ProviderCapabilities[] {
    return this.providers;
  }

  public setProviders(providers: ProviderCapabilities[]): void {
    this.providers = providers;
    this.invalidate(true);
    const doc = this.getEditor()?.state.doc;
    if (doc) {
      this.pendingRanges = [{ from: 0, to: doc.length }];
      this.schedule();
    }
  }

  private getPatterns(): RegExp[] {
    return this.getProviders()
      .filter(provider => provider.supportsSpellcheck !== false)
      .map(provider => new RegExp(provider.pattern, "u"));
  }

  public extension(): Extension {
    return spellingField;
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.invalidate(true);
    if (enabled) {
      const doc = this.getEditor()?.state.doc;
      if (doc) {
        this.pendingRanges = [{ from: 0, to: doc.length }];
        this.schedule();
      }
    }
  }

  public setUserDictionary(words: readonly string[]): void {
    const next = new Set(words);
    if (next.size === this.userDictionary.size
      && [...next].every(word => this.userDictionary.has(word))) return;
    this.userDictionary = next;
    this.invalidate(true);
    const doc = this.getEditor()?.state.doc;
    if (doc) {
      this.pendingRanges = [{ from: 0, to: doc.length }];
      this.schedule();
    }
  }

  public setIgnoredWords(words: readonly string[]): void {
    const next = new Set(words.map(word => word.trim()).filter(Boolean));
    if (next.size === this.ignoredWords.size
      && [...next].every(word => this.ignoredWords.has(word))) return;
    this.ignoredWords = next;
    this.issues = this.issues.map(issue => ({ ...issue, ignored: next.has(issue.word) }));
    this.queueVisibilityRefresh();
  }

  public setEnabledProviders(providerIds: readonly string[] | null): void {
    const next = providerIds === null ? null : new Set(providerIds);
    const unchanged = next === null
      ? this.enabledProviderIds === null
      : this.enabledProviderIds !== null
        && next.size === this.enabledProviderIds.size
        && [...next].every(id => this.enabledProviderIds?.has(id));
    if (unchanged) return;
    this.enabledProviderIds = next;
    this.invalidate(true);
    const doc = this.getEditor()?.state.doc;
    if (doc) {
      this.pendingRanges = [{ from: 0, to: doc.length }];
      this.schedule();
    }
  }

  /** Must be called before replacing the editor state for another document. */
  public activateDocument(documentKey: string): void {
    this.documentKey = documentKey;
    this.invalidate(true);
    const doc = this.getEditor()?.state.doc;
    if (doc) {
      this.pendingRanges = [{ from: 0, to: doc.length }];
      this.schedule();
    }
  }

  /** Invalidates async work immediately; debounce scheduling happens afterwards. */
  public documentChanged(update: ViewUpdate): void {
    if (!this.enabled || !this.documentKey) return;
    this.revision++;
    this.suggestionRequestGeneration++;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (update.transactions?.some(transaction =>
      transaction.isUserEvent("input.type")
      || transaction.isUserEvent("delete.backward")
      || transaction.isUserEvent("delete.forward"))) {
      this.typingStarted(update.state.selection.main.head);
    }

    // Map existing issues offsets through the changes
    this.issues = this.issues.map(issue => {
      const from = update.changes.mapPos(issue.from, -1);
      const to = update.changes.mapPos(issue.to, 1);
      return {
        ...issue,
        revision: this.revision,
        from,
        to,
        docIdentity: update.state.doc
      };
    });
    this.emitVisibleIssues(update.state.selection.main.head);

    // Map existing pending ranges through the changes
    this.pendingRanges = this.pendingRanges.map(r => ({
      from: update.changes.mapPos(r.from, -1),
      to: update.changes.mapPos(r.to, 1)
    }));

    // Extract new changed ranges and expand them
    const patterns = this.getPatterns();
    let newRanges: { from: number; to: number }[] = [];
    update.changes.iterChanges((_fromA, _toA, fromB, toB) => {
      newRanges.push({ from: fromB, to: toB });
    });

    newRanges = newRanges.map(r => expandRange(update.state.doc, r.from, r.to, patterns));
    this.pendingRanges = coalesceRanges([...this.pendingRanges, ...newRanges]);

    this.schedule();
  }

  public selectionChanged(preserveActiveTyping = false): void {
    this.suggestionRequestGeneration++;
    if (!preserveActiveTyping) this.activeTypingPosition = null;
    this.queueVisibilityRefresh();
  }

  public dismissActiveTyping(): void {
    if (this.activeTypingPosition === null) return;
    this.activeTypingPosition = null;
    this.queueVisibilityRefresh();
  }

  public typingStarted(position: number): void {
    this.activeTypingPosition = position;
    this.queueVisibilityRefresh();
  }

  public completionStateChanged(active: boolean): void {
    if (this.completionActive === active) return;
    this.completionActive = active;
    this.queueVisibilityRefresh();
  }

  private queueVisibilityRefresh(): void {
    const generation = ++this.visibilityRefreshGeneration;
    queueMicrotask(() => {
      if (generation === this.visibilityRefreshGeneration) this.applyVisibleIssues();
    });
  }

  public schedule(): void {
    if (!this.enabled || !this.documentKey) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.runAnalysis();
    }, 160);
  }

  public issueAt(position: number): SpellingIssue | null {
    // Incomplete-composition issues are informational editor state, not
    // dictionary entries, so they deliberately do not open spelling actions.
    return this.issues
      .filter(issue => position >= issue.from && position < issue.to && this.isCurrentIssue(issue, false))
      .sort((a, b) => (a.to - a.from) - (b.to - b.from))[0] ?? null;
  }

  public async suggestions(issue: SpellingIssue): Promise<string[]> {
    if (!this.isCurrentIssue(issue)) return [];
    // TODO: Re-enable correction menus for segmented scripts when providers can
    // identify the user's complete intended word instead of an unknown fragment.
    const provider = this.providers.find(candidate => candidate.id === issue.provider);
    if (provider?.supportsCorrections !== true) return [];
    const request = ++this.suggestionRequestGeneration;
    const cached = this.suggestionCache.get(issue.word);
    if (cached) return this.suggestionRequestIsCurrent(request, issue) ? cached : [];
    try {
      const response = await invoke<{ suggestions: string[] }>("language_suggestions", {
        request: {
          provider: issue.provider,
          word: issue.word,
          limit: 5
        }
      });
      const suggestions = response.suggestions;
      if (!this.suggestionRequestIsCurrent(request, issue)) return [];
      this.suggestionCache.set(issue.word, suggestions);
      return suggestions;
    } catch (error) {
      this.warnOnce("language_suggestions", error);
      return [];
    }
  }

  public replace(issue: SpellingIssue, replacement: string): void {
    if (!this.isCurrentIssue(issue)) {
      this.schedule();
      return;
    }
    const editor = this.getEditor();
    editor.dispatch({
      changes: { from: issue.from, to: issue.to, insert: replacement },
      selection: { anchor: issue.from + replacement.length },
      userEvent: "input.complete"
    });
    editor.focus();
  }

  public clear(): void {
    this.invalidate(true);
  }

  private invalidate(clearIssues: boolean): void {
    this.revision++;
    this.suggestionRequestGeneration++;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.pendingRanges = [];
    this.queuedRequest = null;
    if (!clearIssues) return;
    this.issues = [];
    this.onIssuesChanged?.([]);
    const editor = this.getEditor();
    if (editor) editor.dispatch({ effects: setSpellingIssues.of([]) });
  }

  private async runAnalysis(): Promise<void> {
    if (this.activeRequest !== null) {
      if (!this.queuedRequest) {
        this.queuedRequest = { ranges: [...this.pendingRanges] };
      } else {
        this.queuedRequest.ranges = coalesceRanges([...this.queuedRequest.ranges, ...this.pendingRanges]);
      }
      this.pendingRanges = [];
      return;
    }

    const rangesToAnalyze = [...this.pendingRanges];
    this.pendingRanges = [];
    if (rangesToAnalyze.length === 0) return;

    const editor = this.getEditor();
    if (!editor) return;

    const docIdentity = editor.state.doc;
    const documentKey = this.documentKey;
    const revision = this.revision;

    this.activeRequest = { documentKey, revision, docIdentity };

    // Filter out chunks that do not match any provider pattern
    const patterns = this.getPatterns();
    const chunks = rangesToAnalyze
      .map(range => ({
        text: docIdentity.sliceString(range.from, range.to),
        startUtf16: range.from
      }))
      .filter(chunk => patterns.some(pat => pat.test(chunk.text)));

      if (chunks.length === 0) {
      this.activeRequest = null;
      this.applyAnalysisResponse({ tokens: [] }, rangesToAnalyze);
      this.checkQueuedRequest();
      return;
    }

    const startTime = performance.now();
    let response: AnalyzeResponse | null = null;
    try {
      response = await invoke<AnalyzeResponse>("analyze_language_ranges", {
        request: { chunks }
      });
      const enabledProviderIds = this.enabledProviderIds;
      if (response && enabledProviderIds !== null) {
        response = {
          tokens: response.tokens.filter(token => enabledProviderIds.has(token.provider))
        };
      }
    } catch (error) {
      this.warnOnce("analyze_language_ranges", error);
    } finally {
      const duration = performance.now() - startTime;
      console.log(`[Spellcheck] Range-based analysis completed in ${duration.toFixed(2)}ms for ${chunks.length} chunk(s)`);

      this.activeRequest = null;

      if (response && this.analysisIsCurrent(documentKey, revision, docIdentity)) {
        this.applyAnalysisResponse(response, rangesToAnalyze);
      }

      this.checkQueuedRequest();
    }
  }

  private checkQueuedRequest(): void {
    if (this.queuedRequest) {
      const queued = this.queuedRequest;
      this.queuedRequest = null;
      this.pendingRanges = queued.ranges;
      void this.runAnalysis();
    }
  }

  private applyAnalysisResponse(response: AnalyzeResponse, analyzedRanges: { from: number, to: number }[]): void {
    const editor = this.getEditor();
    if (!editor) return;

    const docIdentity = editor.state.doc;
    const documentKey = this.documentKey;
    const revision = this.revision;

    // Remove existing issues that fall within analyzedRanges
    let nextIssues = this.issues.filter(issue => {
      return !analyzedRanges.some(range => {
        return !(issue.to <= range.from || issue.from >= range.to);
      });
    });

    // Map new tokens to SpellingIssues
    const cursor = editor.state.selection.main.head;
    const newIssues = response.tokens
      .filter(token => !token.known
        && !this.userDictionary.has(token.normalizedText)
        && isTypstProseRange(editor.state, token.sourceFromUtf16, token.sourceToUtf16))
      .map(token => ({
        provider: token.provider,
        documentKey,
        revision,
        docIdentity,
        from: token.sourceFromUtf16,
        to: token.sourceToUtf16,
        sourceText: token.sourceText,
        word: token.normalizedText,
        knownPrefix: token.knownPrefix,
        ignored: this.ignoredWords.has(token.normalizedText)
      }));

    nextIssues = [...nextIssues, ...newIssues];
    nextIssues.sort((a, b) => a.from - b.from);
    this.issues = nextIssues;

    const visible = this.visibleIssues(editor, cursor);
    editor.dispatch({ effects: setSpellingIssues.of(visible) });
    this.onIssuesChanged?.(visible);

  }

  private emitVisibleIssues(cursor = this.getEditor().state.selection.main.head): void {
    const editor = this.getEditor();
    const visible = this.visibleIssues(editor, cursor);
    this.onIssuesChanged?.(visible);
  }

  private applyVisibleIssues(cursor = this.getEditor().state.selection.main.head): void {
    const editor = this.getEditor();
    const visible = this.visibleIssues(editor, cursor);
    editor.dispatch({ effects: setSpellingIssues.of(visible) });
    this.onIssuesChanged?.(visible);
  }

  private visibleIssues(editor: EditorView, cursor: number): SpellingIssue[] {
    const visible = this.issues.filter(issue => issue.revision === this.revision
      && issue.docIdentity === editor.state.doc
      && !this.shouldHideKnownPrefix(issue, cursor));
    const incomplete = this.incompleteCompositionIssue(editor);
    if (incomplete && !this.shouldHideKnownPrefix(incomplete, cursor)) visible.push(incomplete);
    return visible;
  }

  private incompleteCompositionIssue(editor: EditorView): SpellingIssue | null {
    if (typeof (editor.state as { field?: unknown }).field !== "function") return null;
    const incomplete = editingPolicyRegistry.incompleteComposition(editor.state);
    if (!incomplete) return null;
    const sourceText = editor.state.doc.sliceString(incomplete.range.from, incomplete.range.to);
    return {
      provider: `${incomplete.policyId}-editing-policy`,
      documentKey: this.documentKey,
      revision: this.revision,
      docIdentity: editor.state.doc,
      from: incomplete.range.from,
      to: incomplete.range.to,
      sourceText,
      word: sourceText,
      knownPrefix: true,
      ignored: false,
      synthetic: true
    };
  }

  private shouldHideKnownPrefix(issue: SpellingIssue, cursor: number): boolean {
    return cursor === issue.to && (
      this.activeTypingPosition === cursor
      || (issue.knownPrefix && this.completionActive)
    );
  }

  private analysisIsCurrent(documentKey: string, revision: number, docIdentity: Text): boolean {
    const editor = this.getEditor();
    return this.enabled && this.documentKey === documentKey && this.revision === revision
      && editor.state.doc === docIdentity;
  }

  private suggestionRequestIsCurrent(request: number, issue: SpellingIssue): boolean {
    return request === this.suggestionRequestGeneration && this.isCurrentIssue(issue);
  }

  private isCurrentIssue(issue: SpellingIssue, verifyText = true): boolean {
    const editor = this.getEditor();
    return this.enabled && issue.documentKey === this.documentKey && issue.revision === this.revision
      && issue.docIdentity === editor.state.doc
      && (!verifyText || editor.state.doc.sliceString(issue.from, issue.to) === issue.sourceText);
  }


  private warnOnce(command: string, error: unknown): void {
    const key = `${command}:${String(error)}`;
    if (this.warnedFailures.has(key)) return;
    this.warnedFailures.add(key);
    console.warn(`Spellcheck ${command} failed:`, error);
  }
}

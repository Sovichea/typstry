import { StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import {
  parseLanguageProviderCapabilitiesList,
  type LanguageProviderCapabilities
} from "../languageSupport";
import { editingPolicyRegistry } from "./editingPolicies/registry";
import type { PerformanceMetric } from "../performance/diagnostics";
import {
  LanguageProviderIndex,
  LanguageScopeClient,
  invalidatedLanguageRanges,
  languageScopeHintsExtension,
  languageScopeStateExtension,
  setLanguageScopeHints,
  setResolvedLanguageScopes,
  type LanguageCatalogEntry,
  type LanguageScopeHint,
  type ResolvedLanguageScopes,
  type RootLanguageContext,
} from "./languageScopes";
import type { LanguageTerminologyEntry, ScopedIgnoredWord, TerminologyEntry } from "../settings";

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
  failures: ProviderFailure[];
};

export type ProviderFailure = {
  provider: string;
  operation: string;
  sourceFromUtf16: number;
  sourceToUtf16: number;
  message: string;
};

export type ProviderCapabilities = LanguageProviderCapabilities;

type RoutedAnalyzeChunk = {
  text: string;
  startUtf16: number;
  provider?: string;
  contentMode: "plainText" | "typstSource";
};

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
  languageFamily?: string;
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

export function expandSpellcheckRange(doc: Text, from: number, to: number, patterns: RegExp[]): { from: number, to: number } {
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

function intersect(
  left: { from: number; to: number },
  right: { from: number; to: number },
): { from: number; to: number } | null {
  const from = Math.max(left.from, right.from);
  const to = Math.min(left.to, right.to);
  return from < to ? { from, to } : null;
}

function matchesTerminology(word: string, entries: readonly TerminologyEntry[]): boolean {
  return entries.some((entry) => entry.exactCase
    ? entry.term === word
    : entry.term.localeCompare(word, undefined, { sensitivity: "base" }) === 0);
}

function terminologyKeys(
  global: readonly TerminologyEntry[],
  project: readonly TerminologyEntry[],
  language: readonly LanguageTerminologyEntry[],
  ignored: readonly ScopedIgnoredWord[],
): Set<string> {
  return new Set([
    ...global.map((entry) => entry.term),
    ...project.map((entry) => entry.term),
    ...language.map((entry) => entry.term),
    ...ignored.map((entry) => entry.term),
  ]);
}

function symmetricDifference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value)).concat([...right].filter((value) => !left.has(value)));
}

function findTermRanges(source: string, terms: readonly string[]): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const term of terms.slice(0, 128)) {
    if (!term) continue;
    let from = 0;
    while ((from = source.indexOf(term, from)) >= 0 && ranges.length < 2_000) {
      ranges.push({ from, to: from + term.length });
      from += Math.max(1, term.length);
    }
  }
  return ranges;
}

function scopeStyleSignature(scopes: ResolvedLanguageScopes | null): string {
  return scopes ? JSON.stringify(scopes.ranges.map((range) => [
    range.style.language,
    range.style.region,
    range.style.script,
    range.sourceKind,
  ])) : "none";
}

function parseLanguageCatalog(value: unknown): LanguageCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.locale !== "string"
      || typeof record.displayName !== "string" || typeof record.languageTag !== "string"
      || !Array.isArray(record.scripts)) return [];
    return [{
      id: record.id,
      locale: record.locale,
      displayName: record.displayName,
      languageTag: record.languageTag,
      scripts: record.scripts.filter((script): script is string => typeof script === "string"),
      installed: record.installed === true,
      bundled: record.bundled === true,
    }];
  });
}

export function coalesceSpellcheckRanges(ranges: { from: number; to: number }[]): { from: number; to: number }[] {
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
  private globalTerminology: TerminologyEntry[] = [];
  private projectTerminology: TerminologyEntry[] = [];
  private languageTerminology: LanguageTerminologyEntry[] = [];
  private scopedIgnoredWords: ScopedIgnoredWord[] = [];
  private terminologySignature = "";
  public issues: SpellingIssue[] = [];
  private suggestionCache = new Map<string, string[]>();
  private providers: ProviderCapabilities[] = [];
  private enabledProviderIds: Set<string> | null = null;
  private embeddedProviderIds: string[] = [];
  private catalog: LanguageCatalogEntry[] = [];
  private providerCatalogReady = false;
  private resolvedScopes: ResolvedLanguageScopes | null = null;
  private previousScopesForInvalidation: ResolvedLanguageScopes | null = null;
  private scopePending = false;
  private rootLanguageContext: RootLanguageContext = "main";
  private readonly languageScopeClient = new LanguageScopeClient();
  
  private pendingRanges: { from: number; to: number }[] = [];
  private activeRequest: { documentKey: string; revision: number; docIdentity: Text } | null = null;
  private queuedRequest: { ranges: { from: number; to: number }[] } | null = null;

  constructor(
    private readonly getEditor: () => EditorView,
    private readonly onIssuesChanged?: (issues: readonly SpellingIssue[]) => void,
    private readonly onPerformance?: (metric: Omit<PerformanceMetric, "recordedAt">) => void
  ) {}

  public async initialize(): Promise<void> {
    const startedAt = performance.now();
    try {
      const [providers, catalog] = await Promise.all([
        invoke<unknown>("get_provider_capabilities"),
        invoke<unknown>("list_hunspell_catalog"),
      ]);
      this.providers = parseLanguageProviderCapabilitiesList(providers);
      this.catalog = parseLanguageCatalog(catalog);
      this.providerCatalogReady = true;
    } catch (error) {
      console.error("Failed to fetch provider capabilities:", error);
    } finally {
      this.onPerformance?.({
        name: "startup.providers",
        milliseconds: performance.now() - startedAt,
        detail: { providerCount: this.providers.length }
      });
    }
  }

  public getProviders(): ProviderCapabilities[] {
    if (this.enabledProviderIds === null) return this.providers;
    return this.providers.filter(provider => this.enabledProviderIds?.has(provider.id));
  }

  public getAllProviders(): ProviderCapabilities[] {
    return this.providers;
  }

  public setProviders(providers: unknown): void {
    this.providers = parseLanguageProviderCapabilitiesList(providers);
    this.setEmbeddedProviders(this.embeddedProviderIds);
    this.providerCatalogReady = false;
    void invoke<unknown>("list_hunspell_catalog").then((catalog) => {
      this.catalog = parseLanguageCatalog(catalog);
      this.providerCatalogReady = true;
      this.publishScopeState();
    }).catch((error) => this.warnOnce("list_hunspell_catalog", error));
    this.invalidate(true);
    const doc = this.getEditor()?.state.doc;
    if (doc) {
      this.pendingRanges = [{ from: 0, to: doc.length }];
      this.scheduleScopeExtraction();
      this.schedule();
    }
  }

  private getPatterns(): RegExp[] {
    return this.getProviders()
      .filter(provider => provider.supportsSpellcheck !== false)
      .map(provider => new RegExp(provider.pattern, "u"));
  }

  public extension(): Extension {
    return [spellingField, languageScopeStateExtension(), languageScopeHintsExtension()];
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.publishScopeHints([]);
    this.invalidate(true);
    if (enabled) {
      const doc = this.getEditor()?.state.doc;
      if (doc) {
        this.pendingRanges = [{ from: 0, to: doc.length }];
        this.scheduleScopeExtraction();
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
      this.scheduleScopeExtraction();
      this.schedule();
    }
  }

  public setTerminology(
    global: readonly TerminologyEntry[],
    project: readonly TerminologyEntry[],
    language: readonly LanguageTerminologyEntry[],
    ignored: readonly ScopedIgnoredWord[],
  ): void {
    const signature = JSON.stringify([global, project, language, ignored]);
    if (signature === this.terminologySignature) return;
    const changedTerms = symmetricDifference(
      terminologyKeys(this.globalTerminology, this.projectTerminology, this.languageTerminology, this.scopedIgnoredWords),
      terminologyKeys(global, project, language, ignored),
    );
    this.terminologySignature = signature;
    this.globalTerminology = [...global];
    this.projectTerminology = [...project];
    this.languageTerminology = [...language];
    this.scopedIgnoredWords = [...ignored];
    const editor = this.getEditor?.();
    if (!editor) return;
    this.invalidate(false);
    this.issues = this.issues
      .map((issue) => ({
        ...issue,
        revision: this.revision,
        docIdentity: editor.state.doc,
        ignored: this.ignoredWords.has(issue.word) || this.scopedIgnoredWords.some((entry) =>
          entry.term === issue.sourceText && (entry.scope !== "languageFamily"
            || entry.languageFamily === issue.languageFamily)),
      }))
      .filter((issue) => !this.acceptsIssueTerminology(issue));
    const affected = findTermRanges(editor.state.doc.toString(), changedTerms);
    this.pendingRanges = coalesceSpellcheckRanges([...this.pendingRanges, ...affected]);
    this.applyVisibleIssues();
    this.scheduleScopeExtraction();
    this.schedule();
  }

  public setEmbeddedProviders(providerIds: readonly string[]): void {
    const unique = [...new Set(providerIds)];
    const next = this.providers.length
      ? this.providerIndex().embeddedProviders([], unique).map((provider) => provider.id)
      : unique;
    if (next.length === this.embeddedProviderIds.length
      && next.every((id, index) => id === this.embeddedProviderIds[index])) return;
    this.embeddedProviderIds = next;
    this.publishScopeState();
    this.invalidateAndAnalyzeAll();
  }

  public setRootLanguageContext(context: RootLanguageContext): void {
    if (context === this.rootLanguageContext) return;
    this.rootLanguageContext = context;
    this.scheduleScopeExtraction();
  }

  public getResolvedScopes(): ResolvedLanguageScopes | null {
    const scopes = this.resolvedScopes ?? this.previousScopesForInvalidation;
    return scopes?.documentKey === this.documentKey ? scopes : null;
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
    this.publishScopeState();
    this.invalidate(true);
    const doc = this.getEditor()?.state.doc;
    if (doc) {
      this.pendingRanges = [{ from: 0, to: doc.length }];
      this.scheduleScopeExtraction();
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
      this.scheduleScopeExtraction();
      this.schedule();
    }
  }

  /** Invalidates async work immediately; debounce scheduling happens afterwards. */
  public documentChanged(update: ViewUpdate): void {
    if (!this.enabled || !this.documentKey) return;
    this.revision++;
    this.previousScopesForInvalidation = this.resolvedScopes ?? this.previousScopesForInvalidation;
    this.resolvedScopes = null;
    this.scopePending = true;
    this.scheduleScopeExtraction();
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

    newRanges = newRanges.map(r => expandSpellcheckRange(update.state.doc, r.from, r.to, patterns));
    this.pendingRanges = coalesceSpellcheckRanges([...this.pendingRanges, ...newRanges]);

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

  private scheduleScopeExtraction(): void {
    const editor = this.getEditor?.();
    if (!editor || !this.documentKey) return;
    const documentKey = this.documentKey;
    const revision = this.revision;
    const startedAt = performance.now();
    this.scopePending = true;
    // Materialize the complete document only after the language-scope debounce.
    // Large documents otherwise incur a second full-text copy for every keypress,
    // including requests that are superseded before native analysis begins.
    void this.languageScopeClient.analyze(
      documentKey,
      revision,
      () => editor.state.doc.toString(),
      this.rootLanguageContext
    )
      .then((scopes) => {
        if (!scopes || this.documentKey !== documentKey || this.revision !== revision) return;
        const previous = this.previousScopesForInvalidation;
        this.previousScopesForInvalidation = null;
        this.resolvedScopes = scopes;
        this.scopePending = false;
        editor.dispatch({ effects: setResolvedLanguageScopes.of(scopes) });
        this.publishScopeState();
        if (scopeStyleSignature(previous) !== scopeStyleSignature(scopes)) {
          this.pendingRanges = coalesceSpellcheckRanges([
            ...this.pendingRanges,
            ...invalidatedLanguageRanges(previous, scopes).map((range) => ({
              from: range.fromUtf16,
              to: range.toUtf16,
            })),
          ]);
        }
        this.onPerformance?.({
          name: "language.scopeParse",
          milliseconds: performance.now() - startedAt,
          detail: {
            nativeMilliseconds: scopes.elapsedMicros / 1_000,
            rangeCount: scopes.ranges.length,
            documentUtf16: scopes.documentUtf16,
          },
        });
        void this.runAnalysis();
      })
      .catch((error) => {
        if (this.documentKey !== documentKey || this.revision !== revision) return;
        this.scopePending = false;
        this.warnOnce("extract_typst_language_scopes", error);
        void this.runAnalysis();
      });
  }

  private publishScopeState(): void {
    if (!this.enabled || !this.providerCatalogReady || !this.resolvedScopes) {
      this.publishScopeHints([]);
      return;
    }
    const index = this.providerIndex();
    const hints: LanguageScopeHint[] = [];
    for (const range of this.resolvedScopes.ranges) {
      if (range.sourceKind === "default" || range.sourceKind === "inherited" || !range.languageDeclaration) continue;
      const resolution = index.resolve(range.style);
      if (resolution.availability === "installed" || resolution.availability === "dynamic"
        || resolution.availability === "invalid") continue;
      const language = resolution.canonicalLocale ?? range.style.language.value ?? "unknown";
      const message = resolution.availability === "disabled"
        ? `${language} spellcheck is intentionally disabled. Enable its provider in Language Tools.`
        : resolution.availability === "downloadable"
          ? `${language} spellcheck is not installed. Open Language Tools to install it.`
          : resolution.availability === "ambiguous"
            ? `${language} matches multiple providers. Select a region or provider in Language Tools.`
          : `${language} spellcheck is not available in Typsastra's provider catalog.`;
      hints.push({
        key: `${range.languageDeclaration.fromUtf16}:${range.languageDeclaration.toUtf16}:${language}:${resolution.availability}`,
        range: range.languageDeclaration,
        language,
        availability: resolution.availability,
        message,
        providerId: resolution.providerId,
      });
    }
    this.publishScopeHints(hints);
  }

  private publishScopeHints(hints: LanguageScopeHint[]): void {
    const editor = this.getEditor?.();
    if (editor) editor.dispatch({ effects: setLanguageScopeHints.of(hints) });
  }

  private providerIndex(): LanguageProviderIndex {
    return new LanguageProviderIndex(
      this.providers,
      this.catalog,
      this.enabledProviderIds === null ? null : [...this.enabledProviderIds],
    );
  }

  private invalidateAndAnalyzeAll(): void {
    this.invalidate(true);
    const doc = this.getEditor?.()?.state.doc;
    if (!doc) return;
    this.pendingRanges = [{ from: 0, to: doc.length }];
    this.scheduleScopeExtraction();
    this.schedule();
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
    if (this.scopePending) return;
    if (this.activeRequest !== null) {
      if (!this.queuedRequest) {
        this.queuedRequest = { ranges: [...this.pendingRanges] };
      } else {
        this.queuedRequest.ranges = coalesceSpellcheckRanges([...this.queuedRequest.ranges, ...this.pendingRanges]);
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

    const routingStartedAt = performance.now();
    const chunks = this.buildAnalysisChunks(rangesToAnalyze, docIdentity);
    this.onPerformance?.({
      name: "language.providerResolution",
      milliseconds: performance.now() - routingStartedAt,
      detail: { chunkCount: chunks.length, rangeCount: rangesToAnalyze.length },
    });

    if (chunks.length === 0) {
      this.activeRequest = null;
      this.applyAnalysisResponse({ tokens: [], failures: [] }, rangesToAnalyze);
      this.checkQueuedRequest();
      return;
    }

    const startTime = performance.now();
    let response: AnalyzeResponse | null = null;
    try {
      response = await invoke<AnalyzeResponse>("analyze_language_ranges", {
        request: { chunks }
      });
      response = { tokens: response.tokens, failures: response.failures ?? [] };
      const enabledProviderIds = this.enabledProviderIds;
      if (response && enabledProviderIds !== null) {
        response = {
          tokens: response.tokens.filter(token => enabledProviderIds.has(token.provider)),
          failures: response.failures.filter(failure => enabledProviderIds.has(failure.provider))
        };
      }
      for (const failure of response.failures) {
        this.warnOnce(`${failure.operation}:${failure.provider}`, failure.message);
      }
    } catch (error) {
      this.warnOnce("analyze_language_ranges", error);
    } finally {
      const duration = performance.now() - startTime;
      console.log(`[Spellcheck] Range-based analysis completed in ${duration.toFixed(2)}ms for ${chunks.length} chunk(s)`);
      this.onPerformance?.({
        name: "language.analysis",
        milliseconds: duration,
        detail: {
          chunkCount: chunks.length,
          submittedUtf16: chunks.reduce((total, chunk) => total + chunk.text.length, 0),
          documentUtf16: docIdentity.length,
          queuedRequests: this.queuedRequest ? 1 : 0
        }
      });

      this.activeRequest = null;

      if (response && this.analysisIsCurrent(documentKey, revision, docIdentity)) {
        this.applyAnalysisResponse(response, rangesToAnalyze);
      }

      this.checkQueuedRequest();
    }
  }

  private buildAnalysisChunks(ranges: readonly { from: number; to: number }[], doc: Text): RoutedAnalyzeChunk[] {
    if (!this.resolvedScopes) {
      const patterns = this.getPatterns();
      return ranges.map((range) => ({
        text: doc.sliceString(range.from, range.to),
        startUtf16: range.from,
        contentMode: "typstSource" as const,
      })).filter((chunk) => patterns.some((pattern) => pattern.test(chunk.text)));
    }
    const index = this.providerIndex();
    const chunks = new Map<string, RoutedAnalyzeChunk>();
    for (const pending of ranges) {
      for (const prose of this.resolvedScopes.proseRanges) {
        const proseRange = intersect(pending, { from: prose.fromUtf16, to: prose.toUtf16 });
        if (!proseRange) continue;
        for (const scope of this.resolvedScopes.ranges) {
          const range = intersect(proseRange, { from: scope.fromUtf16, to: scope.toUtf16 });
          if (!range) continue;
          const resolution = index.resolve(scope.style);
          const primary = resolution.availability === "installed" && resolution.providerId
            ? index.provider(resolution.providerId)
            : null;
          const providerIds: Array<string | undefined> = [];
          if (primary) providerIds.push(primary.id);
          if (resolution.availability === "dynamic") providerIds.push(undefined);
          const primaryScripts = index.scriptsForProviderId(resolution.providerId);
          for (const embedded of index.embeddedProviders(primaryScripts, this.embeddedProviderIds)) {
            providerIds.push(embedded.id);
          }
          const text = doc.sliceString(range.from, range.to);
          for (const providerId of providerIds) {
            const provider = providerId ? index.provider(providerId) : null;
            if (provider && !new RegExp(provider.pattern, "u").test(text)) continue;
            if (!providerId && !this.getPatterns().some((pattern) => pattern.test(text))) continue;
            const key = `${providerId ?? "compat"}:${range.from}:${range.to}`;
            chunks.set(key, {
              text,
              startUtf16: range.from,
              provider: providerId,
              contentMode: "plainText",
            });
          }
        }
      }
    }
    return [...chunks.values()];
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

    const failedRanges = response.failures ?? [];
    // Remove successful providers' existing issues inside analyzed ranges, but
    // retain a provider's last valid issues where its new analysis failed.
    let nextIssues = this.issues.filter(issue => {
      const wasAnalyzed = analyzedRanges.some(range => {
        return !(issue.to <= range.from || issue.from >= range.to);
      });
      if (!wasAnalyzed) return true;
      return failedRanges.some(failure => failure.provider === issue.provider
        && issue.from < failure.sourceToUtf16
        && failure.sourceFromUtf16 < issue.to);
    });

    // Map new tokens to SpellingIssues
    const cursor = editor.state.selection.main.head;
    const newIssues = response.tokens
      .filter(token => !token.known
        && !this.userDictionary.has(token.normalizedText)
        && !this.acceptsTerminology(token)
        && this.isProvenProse(editor.state, token.sourceFromUtf16, token.sourceToUtf16))
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
        ignored: this.isIgnoredTerm(token),
        languageFamily: this.providerLanguageFamily(token.provider) ?? undefined,
      }));

    const deduplicated = new Map<string, SpellingIssue>();
    for (const issue of [...nextIssues, ...newIssues]) {
      deduplicated.set(`${issue.provider}:${issue.from}:${issue.to}`, issue);
    }
    nextIssues = [...deduplicated.values()];
    nextIssues.sort((a, b) => a.from - b.from);
    this.issues = nextIssues;

    const visible = this.visibleIssues(editor, cursor);
    editor.dispatch({ effects: setSpellingIssues.of(visible) });
    this.onIssuesChanged?.(visible);

  }

  private isProvenProse(state: EditorState, from: number, to: number): boolean {
    if (this.resolvedScopes) {
      return this.resolvedScopes.proseRanges.some((range) => range.fromUtf16 <= from && range.toUtf16 >= to);
    }
    return isTypstProseRange(state, from, to);
  }

  private acceptsTerminology(token: EditorToken): boolean {
    if (matchesTerminology(token.sourceText, this.globalTerminology)
      || matchesTerminology(token.sourceText, this.projectTerminology)) return true;
    const family = this.providerLanguageFamily(token.provider);
    return family !== null && matchesTerminology(
      token.sourceText,
      this.languageTerminology.filter((entry) => entry.languageFamily === family),
    );
  }

  private acceptsIssueTerminology(issue: SpellingIssue): boolean {
    return matchesTerminology(issue.sourceText, this.globalTerminology)
      || matchesTerminology(issue.sourceText, this.projectTerminology)
      || Boolean(issue.languageFamily && matchesTerminology(
        issue.sourceText,
        this.languageTerminology.filter((entry) => entry.languageFamily === issue.languageFamily),
      ));
  }

  private isIgnoredTerm(token: EditorToken): boolean {
    if (this.ignoredWords.has(token.normalizedText)) return true;
    const family = this.providerLanguageFamily(token.provider);
    return this.scopedIgnoredWords.some((entry) => entry.term === token.sourceText
      && (entry.scope === "global" || entry.scope === "project"
        || (entry.scope === "languageFamily" && entry.languageFamily === family)));
  }

  private providerLanguageFamily(providerId: string): string | null {
    const tag = this.providers.find((provider) => provider.id === providerId)?.languageTag;
    const family = tag?.split(/[-_]/)[0]?.toLowerCase();
    return family && /^[a-z]{2,3}$/.test(family) ? family : null;
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

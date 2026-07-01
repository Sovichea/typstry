import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";

type SegmentToken = {
  text: string;
  from: number;
  to: number;
  known: boolean;
  knownPrefix: boolean;
};

type TextAnalysis = {
  provider: string;
  normalizedChanged: boolean;
  tokens: SegmentToken[];
};

export type SpellingIssue = {
  from: number;
  to: number;
  word: string;
  knownPrefix: boolean;
};

const setSpellingIssues = StateEffect.define<SpellingIssue[]>();
const spellingField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setSpellingIssues)) continue;
      const decorations = effect.value.map(issue => Decoration.mark({
        class: "cm-spelling-unknown",
        attributes: { title: `${issue.word} is not in the selected language dictionary` }
      }).range(issue.from, issue.to));
      return Decoration.set(decorations, true);
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field)
});

export class SpellcheckController {
  private enabled = true;
  private timer: number | null = null;
  private generation = 0;
  private issues: SpellingIssue[] = [];
  private suggestionCache = new Map<string, string[]>();
  private readonly popup = document.createElement("div");

  constructor(private readonly getEditor: () => EditorView) {
    this.popup.className = "spellcheck-suggestions hidden";
    document.body.appendChild(this.popup);
  }

  public extension(): Extension {
    return spellingField;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
    else this.schedule();
  }

  public schedule(): void {
    if (!this.enabled) return;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.analyze();
    }, 160);
  }

  public issueAt(position: number): SpellingIssue | null {
    return this.issues.find(issue => position >= issue.from && position <= issue.to) ?? null;
  }

  public async suggestions(issue: SpellingIssue): Promise<string[]> {
    const cached = this.suggestionCache.get(issue.word);
    if (cached) return cached;
    const suggestions = await invoke<string[]>("spelling_suggestions", { word: issue.word, limit: 5 });
    this.suggestionCache.set(issue.word, suggestions);
    return suggestions;
  }

  public replace(issue: SpellingIssue, replacement: string): void {
    const editor = this.getEditor();
    editor.dispatch({
      changes: { from: issue.from, to: issue.to, insert: replacement },
      selection: { anchor: issue.from + replacement.length },
      userEvent: "input.complete"
    });
    editor.focus();
    this.hidePopup();
  }

  public clear(): void {
    this.generation++;
    this.issues = [];
    this.hidePopup();
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    const editor = this.getEditor();
    if (editor) editor.dispatch({ effects: setSpellingIssues.of([]) });
  }

  private async analyze(): Promise<void> {
    const editor = this.getEditor();
    const text = editor.state.doc.toString();
    if (!/[\u1780-\u17ff]/u.test(text)) {
      this.clear();
      return;
    }
    const generation = ++this.generation;
    const analysis = await invoke<TextAnalysis | null>("analyze_text", { text });
    if (generation !== this.generation || !this.enabled || !analysis) return;
    if (analysis.normalizedChanged) {
      this.clear();
      return;
    }
    const cursor = editor.state.selection.main.head;
    this.issues = analysis.tokens
      .filter(token => !token.known && /[\u1780-\u17ff]/u.test(token.text))
      .map(token => ({ from: token.from, to: token.to, word: token.text, knownPrefix: token.knownPrefix }));
    const visible = this.issues.filter(issue => !(issue.knownPrefix && cursor === issue.to));
    editor.dispatch({ effects: setSpellingIssues.of(visible) });
    const current = visible.find(issue => cursor >= issue.from && cursor <= issue.to);
    if (current) await this.showSuggestions(current);
    else this.hidePopup();
  }

  private async showSuggestions(issue: SpellingIssue): Promise<void> {
    const suggestions = await this.suggestions(issue);
    if (!suggestions.length || !this.enabled) {
      this.hidePopup();
      return;
    }
    const editor = this.getEditor();
    const coordinates = editor.coordsAtPos(issue.to);
    if (!coordinates) return;
    this.popup.replaceChildren(...suggestions.map(suggestion => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = suggestion;
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", () => this.replace(issue, suggestion));
      return button;
    }));
    this.popup.style.left = `${Math.min(coordinates.left, window.innerWidth - 260)}px`;
    this.popup.style.top = `${Math.min(coordinates.bottom + 4, window.innerHeight - 180)}px`;
    this.popup.classList.remove("hidden");
  }

  private hidePopup(): void {
    this.popup.classList.add("hidden");
    this.popup.replaceChildren();
  }
}

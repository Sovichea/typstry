import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, lineNumberMarkers } from "@codemirror/view";
import type { ProviderAvailability, SourceRange } from "./types";

export interface LanguageScopeHint {
  key: string;
  range: SourceRange;
  language: string;
  availability: Exclude<ProviderAvailability, "installed">;
  message: string;
  providerId: string | null;
}

export const setLanguageScopeHints = StateEffect.define<LanguageScopeHint[]>();

const languageScopeHintsField = StateField.define<LanguageScopeHint[]>({
  create: () => [],
  update(value, transaction) {
    if (transaction.docChanged) {
      value = value.flatMap((hint) => {
        const fromUtf16 = transaction.changes.mapPos(hint.range.fromUtf16, -1);
        const toUtf16 = transaction.changes.mapPos(hint.range.toUtf16, 1);
        return fromUtf16 < toUtf16
          ? [{ ...hint, range: { fromUtf16, toUtf16 } }]
          : [];
      });
    }
    for (const effect of transaction.effects) {
      if (effect.is(setLanguageScopeHints)) value = deduplicateHints(effect.value);
    }
    return value;
  },
});

class LanguageWarningMarker extends GutterMarker {
  constructor(private readonly label: string, private readonly informational: boolean) { super(); }
  eq(other: LanguageWarningMarker): boolean {
    return other.label === this.label && other.informational === this.informational;
  }
  toDOM(): Node {
    const marker = document.createElement("span");
    marker.className = this.informational ? "cm-language-scope-marker info" : "cm-language-scope-marker warning";
    marker.textContent = this.informational ? "i" : "!";
    marker.title = this.label;
    marker.setAttribute("aria-label", this.label);
    marker.setAttribute("role", "button");
    marker.setAttribute("tabindex", "0");
    const openLanguageTools = () => document.dispatchEvent(new CustomEvent("typsastra:open-settings", {
      detail: { panel: "editor" },
    }));
    marker.addEventListener("click", openLanguageTools);
    marker.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter" || (event as KeyboardEvent).key === " ") {
        event.preventDefault();
        openLanguageTools();
      }
    });
    return marker;
  }
}

const languageHintDecorations = EditorView.decorations.compute([languageScopeHintsField], (state) => {
  const ranges = state.field(languageScopeHintsField).flatMap((hint) => {
    const from = Math.max(0, Math.min(state.doc.length, hint.range.fromUtf16));
    const to = Math.max(from, Math.min(state.doc.length, hint.range.toUtf16));
    if (from === to) return [];
    return [Decoration.mark({
      class: `cm-language-scope-hint ${hint.availability}`,
      attributes: { title: hint.message, "aria-label": hint.message },
    }).range(from, to)];
  });
  return Decoration.set(ranges, true);
});

const languageHintLineNumberMarkers = lineNumberMarkers.compute([languageScopeHintsField], (state) => {
    const builder = new RangeSetBuilder<GutterMarker>();
    const seenLines = new Set<number>();
    const hints = [...state.field(languageScopeHintsField)].sort(
      (left, right) => left.range.fromUtf16 - right.range.fromUtf16,
    );
    for (const hint of hints) {
      const position = Math.max(0, Math.min(state.doc.length, hint.range.fromUtf16));
      const line = state.doc.lineAt(position);
      if (seenLines.has(line.from)) continue;
      seenLines.add(line.from);
      builder.add(line.from, line.from, new LanguageWarningMarker(
        hint.message,
        hint.availability === "disabled",
      ));
    }
    return builder.finish();
});

export function languageScopeHintsExtension(): Extension {
  return [languageScopeHintsField, languageHintDecorations, languageHintLineNumberMarkers];
}

function deduplicateHints(hints: readonly LanguageScopeHint[]): LanguageScopeHint[] {
  return [...new Map(hints.map((hint) => [hint.key, hint])).values()];
}

import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import type { Extension, Text } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

export type EditorDiagnosticSeverity = "error" | "warning" | "info" | "hint";

export type EditorDiagnostic = {
  from: number;
  to: number;
  severity: EditorDiagnosticSeverity;
  message: string;
};

export const setEditorDiagnosticsEffect = StateEffect.define<EditorDiagnostic[]>({
  map(diagnostics, mapping) {
    return diagnostics
      .map((diagnostic) => ({
        ...diagnostic,
        from: mapping.mapPos(diagnostic.from),
        to: mapping.mapPos(diagnostic.to)
      }))
      .filter((diagnostic) => diagnostic.to >= diagnostic.from);
  }
});

const diagnosticField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },

  update(value, transaction) {
    let decorations = value.map(transaction.changes);

    for (const effect of transaction.effects) {
      if (effect.is(setEditorDiagnosticsEffect)) {
        decorations = buildDiagnosticDecorations(effect.value, transaction.state.doc.length);
      }
    }

    return decorations;
  },

  provide(field) {
    return EditorView.decorations.from(field);
  }
});

export const editorDiagnosticsExtension: Extension = diagnosticField;

function isWordContinuation(text: string): boolean {
  return /^[\p{L}\p{N}_-]$/u.test(text);
}

export function looksLikeStalePrefixDiagnostic(
  doc: Text,
  from: number,
  to: number,
  message: string
): boolean {
  if (to <= from || from < 0 || to > doc.length) return false;

  const source = doc.sliceString(from, to);
  if (source.length < 2) return false;

  const next = doc.sliceString(to, to + 1);
  if (!next || !isWordContinuation(next)) return false;

  const before = from > 0 ? doc.sliceString(from - 1, from) : "";
  if (before && isWordContinuation(before)) return false;

  const line = doc.lineAt(from);
  const tokenEnd = (() => {
    let cursor = to;
    while (cursor < line.to && isWordContinuation(doc.sliceString(cursor, cursor + 1))) {
      cursor++;
    }
    return cursor;
  })();
  const currentToken = doc.sliceString(from, tokenEnd);
  if (!currentToken.startsWith(source) || currentToken === source) return false;

  const normalizedMessage = message.toLocaleLowerCase();
  const normalizedSource = source.toLocaleLowerCase();
  return normalizedMessage.includes(`"${normalizedSource}"`)
    || normalizedMessage.includes(`'${normalizedSource}'`)
    || normalizedMessage.includes(`\`${normalizedSource}\``)
    || normalizedMessage.includes(normalizedSource);
}

function buildDiagnosticDecorations(diagnostics: EditorDiagnostic[], docLength: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sorted = [...diagnostics].sort((left, right) => left.from - right.from || left.to - right.to);

  for (const diagnostic of sorted) {
    const from = Math.max(0, Math.min(diagnostic.from, docLength));
    const to = Math.max(from, Math.min(diagnostic.to, docLength));
    const markTo = to > from ? to : Math.min(from + 1, docLength);
    if (markTo <= from) continue;

    builder.add(
      from,
      markTo,
      Decoration.mark({
        class: `cm-diagnostic cm-diagnostic-${diagnostic.severity}`,
        attributes: { title: diagnostic.message }
      })
    );
  }

  return builder.finish();
}

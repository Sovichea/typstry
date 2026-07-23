import { EditorSelection } from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";

export type DoubleQuoteAction = "pair" | "single" | "skip" | "wrap";

function adjacentCodePoint(text: string, side: "start" | "end"): string {
  const codePoints = Array.from(text);
  return side === "start" ? codePoints[0] ?? "" : codePoints[codePoints.length - 1] ?? "";
}

function isContentCodePoint(value: string): boolean {
  return /[\p{L}\p{M}\p{N}\p{Extended_Pictographic}]/u.test(value);
}

function hasOddTrailingBackslashes(text: string): boolean {
  let count = 0;
  for (let index = text.length - 1; index >= 0 && text[index] === "\\"; index--) count++;
  return count % 2 === 1;
}

export function doubleQuoteAction(before: string, after: string, hasSelection = false): DoubleQuoteAction {
  if (hasSelection) return "wrap";
  if (after.startsWith('"')) return "skip";
  if (hasOddTrailingBackslashes(before)) return "single";
  if (isContentCodePoint(adjacentCodePoint(before, "end"))
    || isContentCodePoint(adjacentCodePoint(after, "start"))) {
    return "single";
  }
  return "pair";
}

export const insertContextualDoubleQuote: Command = view => {
  if (view.state.readOnly) return false;
  const transaction = view.state.changeByRange(range => {
    const before = view.state.doc.sliceString(0, range.from);
    const after = view.state.doc.sliceString(range.to);
    const action = doubleQuoteAction(before, after, !range.empty);
    if (action === "skip") {
      return { range: EditorSelection.cursor(range.from + 1) };
    }
    if (action === "wrap") {
      const selected = view.state.doc.sliceString(range.from, range.to);
      return {
        changes: { from: range.from, to: range.to, insert: `"${selected}"` },
        range: EditorSelection.range(range.anchor + 1, range.head + 1),
      };
    }
    const insert = action === "pair" ? '""' : '"';
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + 1),
    };
  });
  view.dispatch(view.state.update(transaction, {
    scrollIntoView: true,
    userEvent: "input.type",
  }));
  return true;
};

export const contextualDoubleQuoteExtension = EditorView.inputHandler.of((view, _from, _to, text) => {
  if (text !== '"' || view.composing) return false;
  return insertContextualDoubleQuote(view);
});

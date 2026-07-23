import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { doubleQuoteAction, insertContextualDoubleQuote } from "../src/editor/quoteEditing";

function applyQuote(doc: string, anchor: number, head = anchor): EditorState {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.range(anchor, head),
  });
  const view = {
    get state() { return state; },
    dispatch(transaction: ReturnType<EditorState["update"]>) { state = transaction.state; },
  } as unknown as EditorView;
  expect(insertContextualDoubleQuote(view)).toBe(true);
  return state;
}

describe("contextual double-quote editing", () => {
  test("pairs a quote only in an empty boundary context", () => {
    expect(doubleQuoteAction("", "")).toBe("pair");
    expect(doubleQuoteAction("Start: ", "")).toBe("pair");
    const state = applyQuote("Start: ", 7);
    expect(state.doc.toString()).toBe('Start: ""');
    expect(state.selection.main.head).toBe(8);
  });

  test("inserts only an opener before existing Latin or Khmer text", () => {
    expect(doubleQuoteAction("", "Hello")).toBe("single");
    expect(doubleQuoteAction("", "\u1781\u17D2\u1798\u17C2\u179A")).toBe("single");
    expect(applyQuote("Hello", 0).doc.toString()).toBe('"Hello');
    expect(applyQuote("\u1781\u17D2\u1798\u17C2\u179A", 0).doc.toString()).toBe('"\u1781\u17D2\u1798\u17C2\u179A');
  });

  test("inserts only a closer after existing text", () => {
    expect(doubleQuoteAction("Hello", " ")).toBe("single");
    expect(applyQuote("Hello world", 5).doc.toString()).toBe('Hello" world');
  });

  test("wraps selected text and keeps the inner text selected", () => {
    const state = applyQuote("Hello Khmer", 0, 5);
    expect(state.doc.toString()).toBe('"Hello" Khmer');
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("Hello");
  });

  test("moves over an existing closer and preserves escaped quotes", () => {
    expect(doubleQuoteAction("", '"')).toBe("skip");
    expect(applyQuote('""', 1).doc.toString()).toBe('""');
    expect(applyQuote("\\", 1).doc.toString()).toBe('\\"');
  });
});

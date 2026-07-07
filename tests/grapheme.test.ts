import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { codePointDeletionRange, graphemeBoundaries, graphemeSelectionBoundaryFilter, khmerCompositionBoundaryState, moveSelectionByGrapheme, nextGraphemeBoundary, previousGraphemeBoundary, snapPositionToGraphemeBoundary, snapSelectionToGraphemeBoundaries } from "../src/editor/grapheme";

describe("editor grapheme navigation", () => {
  test("keeps Khmer coeng clusters together", () => {
    const text = "ខ្មែរ";
    const boundaries = graphemeBoundaries(text);
    expect(boundaries.map(boundary => text.slice(boundary.from, boundary.to))).toEqual(["ខ្មែ", "រ"]);
  });

  test("does not merge a completed Khmer coeng cluster into the next cluster", () => {
    const text = "\u179F\u1798\u17D2\u1794\u178F\u17D2\u178F\u17B7";
    const boundaries = graphemeBoundaries(text);
    expect(boundaries.map(boundary => text.slice(boundary.from, boundary.to))).toEqual([
      "\u179F",
      "\u1798\u17D2\u1794",
      "\u178F\u17D2\u178F\u17B7"
    ]);
  });

  test("moves out of the current Khmer cluster instead of staying inside it", () => {
    const doc = Text.of(["ខ្មែរ"]);
    expect(nextGraphemeBoundary(doc, 1)).toBe(4);
    expect(previousGraphemeBoundary(doc, 2)).toBe(0);
  });

  test("snaps cursor placement out of a Khmer cluster", () => {
    const doc = Text.of(["ខ្មែរ"]);
    expect(snapPositionToGraphemeBoundary(doc, 1)).toBe(0);
    expect(snapPositionToGraphemeBoundary(doc, 3)).toBe(4);
  });

  test("snaps CodeMirror selections before they can commit inside a cluster", () => {
    const doc = Text.of(["ខ្មែរ"]);
    const selection = snapSelectionToGraphemeBoundaries(doc, EditorSelection.create([EditorSelection.cursor(2)]));
    expect(selection.main.head).toBe(4);
  });

  test("backspace deletes one Unicode code point except Khmer subscript pairs", () => {
    const doc = Text.of(["ខ្មែរ"]);
    expect(codePointDeletionRange(doc, 4, "backward")).toEqual({ from: 3, to: 4 });
    expect(codePointDeletionRange(doc, 3, "backward")).toEqual({ from: 1, to: 3 });
  });

  test("backspace deletes Khmer coeng plus consonant together inside longer words", () => {
    const doc = Text.of(["\u179F\u1798\u17D2\u1794\u178F\u17D2\u178F\u17B7"]);
    expect(codePointDeletionRange(doc, 4, "backward")).toEqual({ from: 2, to: 4 });
    expect(codePointDeletionRange(doc, 7, "backward")).toEqual({ from: 5, to: 7 });
  });

  test("forward delete removes a complete Khmer grapheme cluster", () => {
    const doc = Text.of(["\u179F\u1798\u17D2\u1794\u178F\u17D2\u178F\u17B7"]);
    expect(codePointDeletionRange(doc, 0, "forward")).toEqual({ from: 0, to: 1 });
    expect(codePointDeletionRange(doc, 1, "forward")).toEqual({ from: 1, to: 4 });
    expect(codePointDeletionRange(doc, 4, "forward")).toEqual({ from: 4, to: 8 });
  });

  test("preserves a temporary boundary after a newly inserted Khmer coeng", () => {
    let state = EditorState.create({
      doc: "\u1780\u1781",
      selection: { anchor: 1 },
      extensions: [khmerCompositionBoundaryState, graphemeSelectionBoundaryFilter]
    });
    state = state.update({
      changes: { from: 1, insert: "\u17D2" },
      selection: { anchor: 2 },
      userEvent: "input.type"
    }).state;

    state = state.update({ selection: { anchor: 2 } }).state;
    expect(state.selection.main.head).toBe(2);
    expect(codePointDeletionRange(state.doc, 2, "backward", 2)).toEqual({ from: 1, to: 2 });
    expect(codePointDeletionRange(state.doc, 2, "forward", 2)).toEqual({ from: 2, to: 3 });

    const completed = state.update({
      changes: { from: 2, insert: "\u1798" },
      selection: { anchor: 3 },
      userEvent: "input.type"
    }).state;
    expect(graphemeBoundaries(completed.doc.sliceString(0)).map(range => completed.doc.sliceString(range.from, range.to))).toEqual([
      "\u1780\u17D2\u1798",
      "\u1781"
    ]);

    state = state.update({ selection: { anchor: 0 } }).state;
    state = state.update({ selection: { anchor: 2 } }).state;
    expect(state.selection.main.head).toBe(3);
  });

  test("extends keyboard selection by Khmer grapheme boundaries", () => {
    const doc = Text.of(["\u179F\u1798\u17D2\u1794\u178F\u17D2\u178F\u17B7"]);
    const first = moveSelectionByGrapheme(
      doc,
      EditorSelection.create([EditorSelection.cursor(0)]),
      "forward",
      true
    );
    expect(first.main.anchor).toBe(0);
    expect(first.main.head).toBe(1);

    const second = moveSelectionByGrapheme(doc, first, "forward", true);
    expect(second.main.anchor).toBe(0);
    expect(second.main.head).toBe(4);

    const third = moveSelectionByGrapheme(doc, second, "forward", true);
    expect(third.main.anchor).toBe(0);
    expect(third.main.head).toBe(8);
  });
});

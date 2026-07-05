import { describe, expect, test } from "bun:test";
import { EditorSelection, Text } from "@codemirror/state";
import { codePointDeletionRange, graphemeBoundaries, moveSelectionByGrapheme, nextGraphemeBoundary, previousGraphemeBoundary, snapPositionToGraphemeBoundary, snapSelectionToGraphemeBoundaries } from "../src/editor/grapheme";

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

  test("delete ranges are one Unicode code point except Khmer subscript pairs", () => {
    const doc = Text.of(["ខ្មែរ"]);
    expect(codePointDeletionRange(doc, 4, "backward")).toEqual({ from: 3, to: 4 });
    expect(codePointDeletionRange(doc, 0, "forward")).toEqual({ from: 0, to: 1 });
    expect(codePointDeletionRange(doc, 3, "backward")).toEqual({ from: 1, to: 3 });
    expect(codePointDeletionRange(doc, 1, "forward")).toEqual({ from: 1, to: 3 });
  });

  test("deletes Khmer coeng plus consonant together inside longer words", () => {
    const doc = Text.of(["\u179F\u1798\u17D2\u1794\u178F\u17D2\u178F\u17B7"]);
    expect(codePointDeletionRange(doc, 4, "backward")).toEqual({ from: 2, to: 4 });
    expect(codePointDeletionRange(doc, 2, "forward")).toEqual({ from: 2, to: 4 });
    expect(codePointDeletionRange(doc, 7, "backward")).toEqual({ from: 5, to: 7 });
    expect(codePointDeletionRange(doc, 5, "forward")).toEqual({ from: 5, to: 7 });
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

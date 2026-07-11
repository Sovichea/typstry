import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState, Text } from "@codemirror/state";
import {
  codePointDeletionRange,
  deletionRangesForSelection,
  graphemeBoundaries,
  moveSelectionByGrapheme
} from "../src/editor/grapheme";
import {
  getTemporaryKhmerBoundary,
  khmerCompositionBoundaryState
} from "../src/editor/editingPolicies/khmer/composition";

type Range = { from: number; to: number };
type EditingFixture = {
  contractVersion: number;
  boundaries: Array<{ name: string; text: string; expected: Range[] }>;
  backwardDeletion: Array<{ name: string; text: string; offset: number; expected: Range }>;
  forwardDeletion: Array<{ name: string; text: string; offset: number; expected: Range }>;
  movement: Array<{
    name: string;
    text: string;
    anchor: number;
    head: number;
    direction: "backward" | "forward";
    extend: boolean;
    expectedAnchor: number;
    expectedHead: number;
  }>;
  multiCursorBackwardDeletion: {
    text: string;
    cursors: number[];
    expected: Range[];
  };
};

const fixture = await Bun.file(
  new URL("./fixtures/khmer/editing.json", import.meta.url)
).json() as EditingFixture;

describe("locked Khmer editing reference fixtures", () => {
  test("uses the current policy contract", () => {
    expect(fixture.contractVersion).toBe(1);
  });

  for (const example of fixture.boundaries) {
    test(`segments editor boundaries: ${example.name}`, () => {
      expect(graphemeBoundaries(example.text)).toEqual(example.expected);
    });
  }

  for (const example of fixture.backwardDeletion) {
    test(`applies backward deletion: ${example.name}`, () => {
      expect(codePointDeletionRange(Text.of([example.text]), example.offset, "backward"))
        .toEqual(example.expected);
    });
  }

  for (const example of fixture.forwardDeletion) {
    test(`applies forward deletion: ${example.name}`, () => {
      expect(codePointDeletionRange(Text.of([example.text]), example.offset, "forward"))
        .toEqual(example.expected);
    });
  }

  for (const example of fixture.movement) {
    test(`applies navigation and selection: ${example.name}`, () => {
      const selection = EditorSelection.create([
        EditorSelection.range(example.anchor, example.head)
      ]);
      const result = moveSelectionByGrapheme(
        Text.of([example.text]),
        selection,
        example.direction,
        example.extend
      ).main;
      expect({ anchor: result.anchor, head: result.head }).toEqual({
        anchor: example.expectedAnchor,
        head: example.expectedHead
      });
    });
  }

  test("merges multiple-cursor COENG deletion ranges deterministically", () => {
    const example = fixture.multiCursorBackwardDeletion;
    const selection = EditorSelection.create(
      example.cursors.map(position => EditorSelection.cursor(position))
    );
    expect(deletionRangesForSelection(Text.of([example.text]), selection, "backward"))
      .toEqual(example.expected);
  });

  test("keeps the temporary composition boundary out of source text", () => {
    let state = EditorState.create({
      doc: "កក",
      extensions: [khmerCompositionBoundaryState]
    });
    state = state.update({
      changes: { from: 1, insert: "្" },
      selection: { anchor: 2 },
      userEvent: "input.type"
    }).state;

    expect(getTemporaryKhmerBoundary(state)).toBe(2);
    expect(state.doc.toString()).toBe("ក្ក");
    expect(state.doc.toString()).not.toContain("\u200c");
  });
});

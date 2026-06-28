import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import {
  PREVIEW_HIGHLIGHT_PREFIX,
  buildHighlightedPreviewSource,
  findPreviewTextMatchInSourceLine,
  originalOffsetFromHighlightedOffset
} from "../src/preview/sourceHighlight";

describe("preview source highlighting", () => {
  test("wraps prose words and preserves source mapping", () => {
    const source = "A heading word";
    const result = buildHighlightedPreviewSource(Text.of([source]), 12, (_text, offset) => offset);

    expect(result?.text).toBe(`A heading ${PREVIEW_HIGHLIGHT_PREFIX}word]`);
    expect(result?.mapping.originalStart).toBe(10);
    expect(originalOffsetFromHighlightedOffset(result!.mapping, result!.mapping.highlightedStart + 2)).toBe(12);
  });

  test("does not inject markup into Typst code, math, raw text, or comments", () => {
    for (const source of ["#let value = 1", "$ value $", "`value`", "// value"]) {
      const cursor = source.indexOf("value") + 2;
      expect(buildHighlightedPreviewSource(Text.of([source]), cursor, (_text, offset) => offset)).toBeNull();
    }
  });

  test("maps preview text clicks back into a source line", () => {
    expect(findPreviewTextMatchInSourceLine("A source sentence", "source sentence", 4)).toEqual({ sourceOffset: 6 });
  });
});

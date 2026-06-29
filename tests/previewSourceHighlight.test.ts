import { describe, expect, test } from "bun:test";
import { findPreviewTextMatchInSourceLine } from "../src/preview/sourceHighlight";

describe("preview source highlighting", () => {
  test("maps preview text clicks back into a source line", () => {
    expect(findPreviewTextMatchInSourceLine("A source sentence", "source sentence", 4)).toEqual({ sourceOffset: 6 });
  });

  test("matches normalized preview whitespace", () => {
    expect(findPreviewTextMatchInSourceLine("A source sentence", "A   source sentence", 5)).toEqual({ sourceOffset: 5 });
  });
});

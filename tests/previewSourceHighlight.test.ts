import { describe, expect, test } from "bun:test";
import {
  findPreviewTextMatchInSource,
  findPreviewTextMatchInSourceLine,
  findRankedPreviewTextMatchInSource
} from "../src/preview/sourceHighlight";

describe("preview source highlighting", () => {
  test("maps preview text clicks back into a source line", () => {
    expect(findPreviewTextMatchInSourceLine("A source sentence", "source sentence", 4)).toEqual({ sourceOffset: 6 });
  });

  test("matches normalized preview whitespace", () => {
    expect(findPreviewTextMatchInSourceLine("A source sentence", "A   source sentence", 5)).toEqual({ sourceOffset: 3 });
  });

  test("returns offsets in the original source line after collapsed whitespace", () => {
    expect(findPreviewTextMatchInSourceLine("A   source sentence", "A source sentence", 5)).toEqual({ sourceOffset: 7 });
  });

  test("normalizes the clicked preview offset before matching", () => {
    expect(findPreviewTextMatchInSourceLine("A source sentence", "A\nsource sentence", 9)).toEqual({ sourceOffset: 9 });
  });

  test("maps Khmer clicks after a rendered space using the full text offset", () => {
    expect(findPreviewTextMatchInSourceLine("សួស្តី ពិភពលោក", "សួស្តី ពិភពលោក", 8)).toEqual({ sourceOffset: 8 });
  });

  test("uses the source-position hint to disambiguate repeated text", () => {
    expect(findPreviewTextMatchInSourceLine("កូន ខ្មែរ កូន ខ្មែរ", "កូន ខ្មែរ", 5, 10)).toEqual({ sourceOffset: 15 });
  });

  test("finds rendered text in a multi-line source document", () => {
    const source = "= First\n\n#include \"chapter.typ\"\n\nភាសាខ្មែរសម្រាប់សរសេរ";
    expect(findPreviewTextMatchInSource(source, "ភាសាខ្មែរសម្រាប់សរសេរ", 8, 0))
      .toEqual({ sourceOffset: source.indexOf("ភាសាខ្មែរ") + 8 });
  });

  test("ranks a long click context instead of an unrelated short fragment", () => {
    const source = "កូននៅទីនេះ\n\nភាសាខ្មែរមានប្រវត្តិយូរអង្វែងសម្រាប់ប្រជាជនខ្មែរ";
    const preview = "ភាសាខ្មែរមានប្រវត្តិយូរអង្វែងសម្រាប់ប្រជាជនខ្មែរ";
    const match = findRankedPreviewTextMatchInSource(source, preview, 20, 0);
    expect(match?.sourceOffset).toBe(source.indexOf("ភាសាខ្មែរ") + 20);
    expect(match?.score).toBeGreaterThanOrEqual(24);
  });

  test("rejects ambiguous three-character fallback matches", () => {
    expect(findRankedPreviewTextMatchInSource("abc elsewhere", "abc", 1, 0)).toBeNull();
  });

  test("matches prepared Khmer PDF text containing invisible boundaries", () => {
    const source = "ភាសាខ្មែរមានប្រវត្តិយូរអង្វែង";
    const rendered = "ភាសាខ្មែរ\u200bមាន\u200bប្រវត្តិ\u200bយូរអង្វែង";
    const match = findRankedPreviewTextMatchInSource(source, rendered, rendered.indexOf("ប្រវត្តិ") + 3, 0);
    expect(match?.sourceOffset).toBe(source.indexOf("ប្រវត្តិ") + 3);
  });
});

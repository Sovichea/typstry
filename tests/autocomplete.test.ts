import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import {
  applyTextForHashPrefix,
  allowsLanguageWordCompletionOnLine,
  completionEditOffsets,
  displayLabelForHashPrefix,
  fontCompletionValueStart,
  languageCompletionRange,
  languageCompletionValidFor,
  lspCompletionEditOffsets,
  quotedCompletionEditOffsets
} from "../src/editor/autocomplete";

describe("language word completion context", () => {
  test("mounts editor tooltips above preview overlays", async () => {
    const source = await Bun.file(new URL("../src/editor/extensions.ts", import.meta.url)).text();
    const css = await Bun.file(new URL("../src/style.css", import.meta.url)).text();

    expect(source).toContain("tooltips({ parent: document.body })");
    expect(css).toContain(".cm-tooltip {");
    expect(css).toContain("z-index: 12000 !important");
  });

  test("allows prose and content-block text", () => {
    expect(allowsLanguageWordCompletionOnLine("This paragraph has sch", 19)).toBe(true);
    expect(allowsLanguageWordCompletionOnLine('#figure(image("photo.png"))[The capt', 33)).toBe(true);
  });

  test("blocks Typst syntax and code strings", () => {
    expect(allowsLanguageWordCompletionOnLine('#include "stories/rabbit', 19)).toBe(false);
    expect(allowsLanguageWordCompletionOnLine('#import "templates/chapt', 19)).toBe(false);
    expect(allowsLanguageWordCompletionOnLine('#set text(font: "Fira', 18)).toBe(false);
    expect(allowsLanguageWordCompletionOnLine("#let previewRoot = tr", 5)).toBe(false);
  });
});

describe("LSP autocomplete edits", () => {
  test("keeps a font completion range active across spaces", () => {
    const doc = Text.of(['#set text(font: "Khmer OS")']);
    expect(fontCompletionValueStart(doc, 22)).toBe(17);
    expect(fontCompletionValueStart(doc, 25)).toBe(17);
  });

  test("replaces the full quoted font value for a multi-word completion", () => {
    const doc = Text.of(['#set text(font: "Khmer")']);
    const offsets = lspCompletionEditOffsets(
      doc,
      {
        newText: '"Khmer OS Siemreap"',
        range: {
          start: { line: 0, character: 16 },
          end: { line: 0, character: 23 }
        }
      },
      (_text, character) => character
    );

    expect(offsets).toEqual({ from: 16, to: 23 });
    const completed = doc.sliceString(0, offsets!.from)
      + '"Khmer OS Siemreap"'
      + doc.sliceString(offsets!.to);
    expect(completed)
      .toBe('#set text(font: "Khmer OS Siemreap")');
  });

  test("uses the replace range from an LSP insert-replace edit", () => {
    const doc = Text.of(['#set text(font: "Khmer")']);
    const offsets = lspCompletionEditOffsets(
      doc,
      {
        newText: '"Khmer OS"',
        insert: {
          start: { line: 0, character: 17 },
          end: { line: 0, character: 22 }
        },
        replace: {
          start: { line: 0, character: 16 },
          end: { line: 0, character: 23 }
        }
      },
      (_text, character) => character
    );

    expect(offsets).toEqual({ from: 16, to: 23 });
  });

  test("replaces an existing quoted value when the server omits an edit range", () => {
    const closed = Text.of(['#set text(font: "Khmer OS")']);
    expect(quotedCompletionEditOffsets(closed, 25, '"Khmer OS Siemreap"'))
      .toEqual({ from: 16, to: 26 });

    const unfinished = Text.of(['#set text(font: "Khmer OS']);
    expect(quotedCompletionEditOffsets(unfinished, unfinished.length, '"Khmer OS Siemreap"'))
      .toEqual({ from: 16, to: unfinished.length });
  });

  test("preserves the opening quote when Tinymist only supplies a closing quote", () => {
    const doc = Text.of(['#set text(font: "Khmer OS")']);
    const beforeClosingQuote = quotedCompletionEditOffsets(doc, 25, 'Khmer OS Bokor"');
    const afterClosingQuote = quotedCompletionEditOffsets(doc, 26, 'Khmer OS Bokor"');

    expect(beforeClosingQuote).toEqual({ from: 17, to: 26 });
    expect(afterClosingQuote).toEqual({ from: 17, to: 26 });
    const completed = doc.sliceString(0, beforeClosingQuote!.from)
      + 'Khmer OS Bokor"'
      + doc.sliceString(beforeClosingQuote!.to);
    expect(completed).toBe('#set text(font: "Khmer OS Bokor")');
  });

  test("replaces the full font value even when Tinymist targets only the current token", () => {
    const doc = Text.of(['#set text(font: "Khmer OS")']);
    const edit = completionEditOffsets(
      doc,
      25,
      'Khmer OS Bokor"',
      {
        newText: 'Khmer OS Bokor"',
        range: {
          start: { line: 0, character: 23 },
          end: { line: 0, character: 25 }
        }
      },
      (_text, character) => character
    );

    expect(edit).toEqual({ from: 17, to: 26 });
    const completed = doc.sliceString(0, edit!.from)
      + 'Khmer OS Bokor"'
      + doc.sliceString(edit!.to);
    expect(completed).toBe('#set text(font: "Khmer OS Bokor")');
  });

  test("does not prepend an extra hash when Tinymist supplies the edit range", () => {
    expect(displayLabelForHashPrefix("set", "keyword", true)).toBe("#set");
    expect(applyTextForHashPrefix("set", "keyword", true, false)).toBe("#set");
    expect(applyTextForHashPrefix("set", "keyword", true, true)).toBe("set");
  });
});

describe("segmented language completion", () => {
  test("refreshes bounded native results after every typed character", () => {
    expect(languageCompletionValidFor()).toBe(false);
  });

  test("replaces only the final word in an unspaced run", () => {
    expect(languageCompletionRange(10, 12, {
      provider: "khmer-segmenter",
      from: 7,
      to: 12,
      options: ["word"]
    })).toEqual({ from: 17, to: 22 });
  });

  test("rejects a response for a stale run length", () => {
    expect(languageCompletionRange(0, 13, {
      provider: "khmer-segmenter",
      from: 7,
      to: 12,
      options: ["word"]
    })).toBeNull();
  });
});

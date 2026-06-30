import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import {
  completionEditOffsets,
  fontCompletionValueStart,
  lspCompletionEditOffsets,
  quotedCompletionEditOffsets
} from "../src/editor/autocomplete";

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
});

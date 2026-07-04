import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import { looksLikeStalePrefixDiagnostic } from "../src/editor/diagnostics";

describe("editor diagnostics", () => {
  test("rejects stale LSP diagnostics for a boolean literal prefix", () => {
    const doc = Text.of(['#set par(hyphenate: true)']);
    const from = '#set par(hyphenate: '.length;
    const to = from + 'tr'.length;

    expect(looksLikeStalePrefixDiagnostic(doc, from, to, '"tr" is an invalid argument'))
      .toBe(true);
  });

  test("rejects stale diagnostics left behind after accepting a completion", () => {
    const doc = Text.of(['#set par(hyphenate: false)']);
    const from = '#set par(hyphenate: '.length;
    const to = from + 'fa'.length;

    expect(looksLikeStalePrefixDiagnostic(doc, from, to, '`fa` is an invalid argument'))
      .toBe(true);
  });

  test("keeps diagnostics that still cover the current source text", () => {
    const doc = Text.of(['#set par(hyphenate: fals)']);
    const from = '#set par(hyphenate: '.length;
    const to = from + 'fals'.length;

    expect(looksLikeStalePrefixDiagnostic(doc, from, to, '"fals" is an invalid argument'))
      .toBe(false);
  });

  test("keeps diagnostics that do not quote the ranged source", () => {
    const doc = Text.of(['#set par(hyphenate: false)']);
    const from = '#set par(hyphenate: '.length;
    const to = from + 'fa'.length;

    expect(looksLikeStalePrefixDiagnostic(doc, from, to, 'expected a boolean value'))
      .toBe(false);
  });
});

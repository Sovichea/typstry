import { describe, expect, test } from "bun:test";
import { LanguageScopeClient } from "../src/editor/languageScopes/client";
import { invalidatedLanguageRanges, resolveLanguageScopes } from "../src/editor/languageScopes/resolver";
import type { LanguageScopeExtraction, TextStyleMutation } from "../src/editor/languageScopes/types";

const mutation = (values: Partial<TextStyleMutation>): TextStyleMutation => ({
  kind: "setRule",
  applyFromUtf16: 0,
  applyToUtf16: 20,
  declarationFromUtf16: 0,
  declarationToUtf16: 1,
  diagnosticFromUtf16: 0,
  diagnosticToUtf16: 1,
  order: 1,
  contentMode: "typstSource",
  ...values,
});

const extraction = (mutations: TextStyleMutation[] = []): LanguageScopeExtraction => ({
  documentKey: "main.typ",
  revision: 1,
  parserVersion: "test",
  documentUtf16: 20,
  mutations,
  proseRanges: [{ fromUtf16: 0, toUtf16: 20 }],
  syntaxErrors: [],
  elapsedMicros: 1,
});

describe("Typst language-scope resolver", () => {
  test("keeps the Phase 1 multilingual routing fixture versioned", async () => {
    const fixture = await Bun.file("tests/fixtures/language-scopes/routing-contracts.json").json();
    expect(fixture.contractVersion).toBe(1);
    expect(fixture.cases.map((entry: { name: string }) => entry.name)).toContain(
      "french-does-not-fall-through-to-english",
    );
    expect(fixture.cases).toHaveLength(5);
  });

  test("uses Typst main-document defaults", () => {
    const result = resolveLanguageScopes(extraction());
    expect(result.ranges).toHaveLength(1);
    expect(result.ranges[0]!.style).toEqual({
      language: { confidence: "static", value: "en" },
      region: { confidence: "static", value: null },
      script: { confidence: "static", value: "auto" },
    });
  });

  test("inherits lang, region, and script independently across nested scopes", () => {
    const result = resolveLanguageScopes(extraction([
      mutation({ language: { confidence: "static", value: "FR" } }),
      mutation({
        kind: "textCall",
        applyFromUtf16: 5,
        applyToUtf16: 10,
        order: 2,
        region: { confidence: "static", value: "ca" },
        script: { confidence: "static", value: "Latn" },
      }),
    ]));
    expect(result.ranges.map((range) => [
      range.fromUtf16,
      range.toUtf16,
      range.style.language.value,
      range.style.region.value,
      range.style.script.value,
    ])).toEqual([
      [0, 5, "fr", null, "auto"],
      [5, 10, "fr", "CA", "latn"],
      [10, 20, "fr", null, "auto"],
    ]);
  });

  test("later set rules win and dynamic fields do not contaminate independent fields", () => {
    const result = resolveLanguageScopes(extraction([
      mutation({ language: { confidence: "static", value: "fr" } }),
      mutation({
        applyFromUtf16: 8,
        order: 2,
        language: { confidence: "dynamic", value: null },
        region: { confidence: "static", value: "FR" },
      }),
    ]));
    expect(result.ranges[1]!.style.language.confidence).toBe("dynamic");
    expect(result.ranges[1]!.style.region.value).toBe("FR");
    expect(result.ranges[1]!.style.script.value).toBe("auto");
  });

  test("reports only changed effective spans for incremental invalidation", () => {
    const previous = resolveLanguageScopes(extraction());
    const next = resolveLanguageScopes(extraction([
      mutation({ applyFromUtf16: 7, language: { confidence: "static", value: "es" } }),
    ]));
    expect(invalidatedLanguageRanges(previous, next)).toEqual([{ fromUtf16: 7, toUtf16: 20 }]);
  });

  test("drops stale debounced and native responses", async () => {
    const pending: Array<(value: LanguageScopeExtraction) => void> = [];
    const client = new LanguageScopeClient(
      () => new Promise((resolve) => pending.push(resolve)),
      0,
    );
    const first = client.analyze("main.typ", 1, "first");
    await Bun.sleep(1);
    const second = client.analyze("main.typ", 2, "second");
    await Bun.sleep(1);
    pending[0]!(extraction());
    pending[1]!({ ...extraction(), revision: 2 });
    expect(await first).toBeNull();
    expect((await second)?.revision).toBe(2);
  });
});

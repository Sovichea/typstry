import { describe, expect, test } from "bun:test";
import {
  codeEditorFonts,
  codeEditorFontStack,
  detectUnicodeEditorFont
} from "../src/editor/fontCatalog";

describe("editor font catalog", () => {
  test("defaults to bundled Fira Mono and contains no UI fonts", () => {
    expect(codeEditorFonts[0].id).toBe("fira-mono");
    expect(codeEditorFonts.every(font => font.fontFamily !== "MiSans Latin")).toBe(true);
    expect(codeEditorFontStack("fira-mono").startsWith('"Fira Mono"')).toBe(true);
  });

  test("only recommends a registered Unicode font for matching scripts", () => {
    expect(detectUnicodeEditorFont("សួស្តី")?.id).toBe("mi-sans-khmer");
    expect(detectUnicodeEditorFont("Ελληνικά")).toBeNull();
    expect(detectUnicodeEditorFont("français")).toBeNull();
  });

  test("places an explicit Unicode fallback after the selected code font", () => {
    expect(codeEditorFontStack("fira-mono", "MiSans Khmer").startsWith('"Fira Mono", "MiSans Khmer"')).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { detectDocumentScript, detectDocumentScripts, detectTypographyScripts, parseTypographyBlock, renderTypographyBlock, typographyEdit, typographyScaleChange } from "../src/editor/documentTypography";

describe("document typography", () => {
  test("confirms only manual changes to a non-unit font scale", () => {
    expect(typographyScaleChange(1, 1)).toBe("unchanged");
    expect(typographyScaleChange(1.2, 1)).toBe("apply");
    expect(typographyScaleChange(1, 1.2)).toBe("confirm");
    expect(typographyScaleChange(1.2, 1.3)).toBe("confirm");
  });
  const config = {
    primary: { family: "Calibri", script: "latin" },
    baseSizePt: 11,
    embedded: [
      { family: "MiSans Khmer", script: "khmer", scale: 1.05 },
      { family: "MiSans Lao", script: "lao", scale: 1 }
    ]
  };

  test("renders reliable Typst font rules", () => {
    expect(renderTypographyBlock(config)).toContain('#set text(font: ("Calibri", "MiSans Khmer", "MiSans Lao"), size: 11pt)');
    expect(renderTypographyBlock(config)).toContain('// typsastra:font-roles {"primary":{"family":"Calibri","script":"latin"},"embedded":[{"family":"MiSans Khmer","script":"khmer","scale":1.05},{"family":"MiSans Lao","script":"lao","scale":1}]}');
    expect(renderTypographyBlock(config)).not.toContain("#show regex(");
    expect(renderTypographyBlock(config)).not.toContain("show raw");
    expect(parseTypographyBlock(renderTypographyBlock(config))).toEqual(config);
  });

  test("migrates the former regex size adjustment to a uniform scale", () => {
    const legacy = [
      "// typsastra:typography:start",
      '#set text(font: "Calibri", size: 10pt)',
      '#show regex("\\p{Khmer}+"): set text(font: "MiSans Khmer", size: 1em + 0.5pt)',
      "// typsastra:typography:end",
      ""
    ].join("\n");
    expect(parseTypographyBlock(legacy)).toEqual({
      primary: { family: "Calibri", script: "latin" },
      baseSizePt: 10,
      embedded: [{ family: "MiSans Khmer", script: "khmer", scale: 1.05 }]
    });
  });

  test("parses the previous single-fallback metadata", () => {
    const legacy = [
      "// typsastra:typography:start",
      '// typsastra:complex-font {"family":"MiSans Khmer","script":"khmer","scale":1.1}',
      '#set text(font: ("Calibri", "MiSans Khmer"), size: 11pt)',
      "// typsastra:typography:end",
      ""
    ].join("\n");
    expect(parseTypographyBlock(legacy)).toEqual({
      primary: { family: "Calibri", script: "latin" },
      baseSizePt: 11,
      embedded: [{ family: "MiSans Khmer", script: "khmer", scale: 1.1 }]
    });
  });

  test("supports non-Latin primary scripts and Latin-only documents", () => {
    const khmerPrimary = {
      primary: { family: "MiSans Khmer", script: "khmer" },
      baseSizePt: 11,
      embedded: [{ family: "Calibri", script: "latin", scale: 1 }]
    };
    const complexBlock = renderTypographyBlock(khmerPrimary);
    expect(complexBlock).toContain('#set text(font: ("MiSans Khmer", "Calibri"), size: 11pt)');
    expect(parseTypographyBlock(complexBlock)).toEqual(khmerPrimary);

    const latinOnly = { ...config, embedded: [] };
    const latinBlock = renderTypographyBlock(latinOnly);
    expect(latinBlock).toContain('#set text(font: "Calibri", size: 11pt)');
    expect(latinBlock).not.toContain("#show regex(");
    expect(parseTypographyBlock(latinBlock)).toEqual(latinOnly);
  });

  test("supports disabling managed typography", () => {
    const disabledBoth = { ...config, primary: null, embedded: [] };
    const disabledBlock = renderTypographyBlock(disabledBoth);
    expect(disabledBlock).not.toContain("#set text(");
    expect(disabledBlock).not.toContain("#show regex(");
    expect(parseTypographyBlock(disabledBlock)).toBeNull();
  });

  test("updates one managed block and preserves the preview directive", () => {
    const original = "// legacy preview directive\n= Chapter\n";
    const first = typographyEdit(original, config);
    const withBlock = original.slice(0, first.from) + first.insert + original.slice(first.to);
    expect(withBlock.startsWith("// typsastra:typography:start")).toBe(true);

    const second = typographyEdit(withBlock, { ...config, primary: { family: "MiSans Latin", script: "latin" } });
    const updated = withBlock.slice(0, second.from) + second.insert + withBlock.slice(second.to);
    expect(updated.match(/typsastra:typography:start/g)?.length).toBe(1);
    expect(updated).toContain('font: ("MiSans Latin", "MiSans Khmer", "MiSans Lao")');
  });

  test("detects the dominant complex script", () => {
    expect(detectDocumentScript("Latin ខ្មែរ ខ្មែរ")?.id).toBe("khmer");
    expect(detectDocumentScript("Latin only")).toBeNull();
  });

  test("detects every script in dominance order", () => {
    expect(detectDocumentScripts("ខ្មែរ ខ្មែរ ລາວ العربية").map(script => script.id)).toEqual(["khmer", "arabic", "lao"]);
  });

  test("detects a primary script and embedded scripts in dominance order", () => {
    expect(detectTypographyScripts("English English English ខ្មែរ العربية").map(script => script.id))
      .toEqual(["latin", "arabic", "khmer"]);
    expect(detectTypographyScripts("ខ្មែរ ខ្មែរ English").map(script => script.id))
      .toEqual(["khmer", "latin"]);
  });
});

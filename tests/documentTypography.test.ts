import { describe, expect, test } from "bun:test";
import { detectDocumentScript, parseTypographyBlock, renderTypographyBlock, typographyEdit, typographyScaleChange } from "../src/editor/documentTypography";

describe("document typography", () => {
  test("confirms only manual changes to a non-unit font scale", () => {
    expect(typographyScaleChange(1, 1)).toBe("unchanged");
    expect(typographyScaleChange(1.2, 1)).toBe("apply");
    expect(typographyScaleChange(1, 1.2)).toBe("confirm");
    expect(typographyScaleChange(1.2, 1.3)).toBe("confirm");
  });
  const config = {
    latinFont: "Calibri",
    latinSizePt: 11,
    complexFont: "MiSans Khmer",
    complexScript: "khmer",
    complexScale: 1.05
  };

  test("renders reliable Typst font rules", () => {
    expect(renderTypographyBlock(config)).toContain('#set text(font: ("Calibri", "MiSans Khmer"), size: 11pt)');
    expect(renderTypographyBlock(config)).toContain('// typsastra:complex-font {"family":"MiSans Khmer","script":"khmer","scale":1.05}');
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
      latinFont: "Calibri",
      latinSizePt: 10,
      complexFont: "MiSans Khmer",
      complexScript: "khmer",
      complexScale: 1.05
    });
  });

  test("supports independent Latin and complex-script rules", () => {
    const complexOnly = { ...config, latinFont: null };
    const complexBlock = renderTypographyBlock(complexOnly);
    expect(complexBlock).toContain('#set text(font: "MiSans Khmer", size: 11pt)');
    expect(parseTypographyBlock(complexBlock)).toEqual({ ...complexOnly, latinSizePt: 11 });

    const latinOnly = { ...config, complexFont: null };
    const latinBlock = renderTypographyBlock(latinOnly);
    expect(latinBlock).toContain('#set text(font: "Calibri", size: 11pt)');
    expect(latinBlock).not.toContain("#show regex(");
    expect(parseTypographyBlock(latinBlock)).toEqual({
      ...latinOnly,
      complexScript: "khmer",
      complexScale: 1
    });
  });

  test("supports disabling both Latin and complex-script rules", () => {
    const disabledBoth = { ...config, latinFont: null, complexFont: null };
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

    const second = typographyEdit(withBlock, { ...config, latinFont: "MiSans Latin" });
    const updated = withBlock.slice(0, second.from) + second.insert + withBlock.slice(second.to);
    expect(updated.match(/typsastra:typography:start/g)?.length).toBe(1);
    expect(updated).toContain('font: ("MiSans Latin", "MiSans Khmer")');
  });

  test("detects the dominant complex script", () => {
    expect(detectDocumentScript("Latin ខ្មែរ ខ្មែរ")?.id).toBe("khmer");
    expect(detectDocumentScript("Latin only")).toBeNull();
  });
});

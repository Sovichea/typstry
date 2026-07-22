import { describe, expect, test } from "bun:test";
import {
  externalReferenceLabels,
  effectiveTemplateTypography,
  ensureTypographyTemplateApplication,
  findLocalTemplateApplication,
  findTemplateFunctionName,
  newTypographyTemplate,
  templatePreviewSource,
  templateTypographyEdit
} from "../src/editor/templateTypography";

const config = {
  baseSizePt: 11,
  fonts: [
    { family: "MiSans Latin", script: "latin", scale: 1 },
    { family: "MiSans Khmer", script: "khmer", scale: 1 }
  ]
};

describe("template typography", () => {
  test("separates chapter-local labels from external references", () => {
    expect(externalReferenceLabels("See @local and @scripts. <local>")).toEqual(["scripts"]);
  });
  test("traces a show rule to a local template import", () => {
    const main = '#import "styles/thesis.typ": thesis\n#show: thesis.with(title: "Draft")\n#include "chapter.typ"';
    expect(findLocalTemplateApplication(main)).toEqual({
      functionName: "thesis",
      importPath: "styles/thesis.typ",
      showExpression: 'thesis.with(title: "Draft")'
    });
  });

  test("detects template functions in file", () => {
    expect(findTemplateFunctionName("#let project(title: none, body) = {\n  body\n}")).toEqual("project");
    expect(findTemplateFunctionName("#let project(body, author: none) = {\n  body\n}")).toEqual("project");
    expect(findTemplateFunctionName("#let project(title: none) = {\n  title\n}")).toBeNull();
  });

  test("inserts set and show rules inside a template function", () => {
    const source = "#let thesis(title: none, body) = {\n  body\n}\n";
    const edit = templateTypographyEdit(source, "thesis", config)!;
    const updated = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
    expect(updated).toContain('  set text(');
    expect(updated).toContain('(name: "MiSans Khmer", covers: regex("\\p{scx=Khmer}"))');
    expect(updated).toContain("// typsastra:script-fonts ");
    expect(updated).not.toContain("// typsastra:document-scripts ");
    expect(updated).not.toContain('"language"');
    expect(updated).not.toContain("show regex(");
    expect(effectiveTemplateTypography(
      '#import "template.typ": thesis\n#show: thesis\n// typsastra:document-scripts [{"family":"Main Latin","script":"latin","scale":1,"language":"en"}]',
      updated.replace("size: 11pt", "size: 13pt")
    )).toEqual({
      baseSizePt: 13,
      fonts: [{ family: "Main Latin", script: "latin", scale: 1, language: "en" }]
    });
  });

  test("creates a portable local fallback and preview source", () => {
    expect(newTypographyTemplate(config)).toContain("#let typsastra-typography(body)");
    const edit = ensureTypographyTemplateApplication("= Main\n");
    expect(edit.insert).toContain('#show: typsastra-typography');
    expect(templatePreviewSource(
      { functionName: "thesis", importPath: "template.typ", showExpression: "thesis.with()" },
      "/template.typ",
      "/chapters/one.typ",
      "See @outside and @inside.\n= Local <inside>"
    )).toContain('#include "/chapters/one.typ"');
    expect(templatePreviewSource(
      { functionName: "thesis", importPath: "template.typ", showExpression: "thesis.with()" },
      "/template.typ",
      "/chapters/one.typ",
      "See @outside and @inside.\n= Local <inside>"
    )).toContain("ref.where(target: <outside>)");
    expect(templatePreviewSource(
      { functionName: "thesis", importPath: "template.typ", showExpression: "thesis.with()" },
      "/template.typ",
      "/chapters/one.typ",
      "See @outside and @inside.\n= Local <inside>"
    )).not.toContain("ref.where(target: <inside>)");
  });
});

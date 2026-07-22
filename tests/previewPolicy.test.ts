import { describe, expect, test } from "bun:test";
import { activeFileCanRenderPreview, allowsStandalonePreview, documentScriptsForPreviewContext, participatesInPreviewCompilation, previewLspMainPath, previewRefreshStyle, previewSessionIdentity, previewTargetStartsMainCompiler, researchDocumentIdentity, sourceMapPreviewTaskId, staleSourceMapTaskIds, supportsResponsivePartialRendering, tinymistPreviewArguments, tinymistPreviewByteColumn, tinymistPreviewNearbyByteColumns, tinymistPreviewNearbySourceColumns, tinymistPreviewPreferredSourceColumn, tinymistPreviewSourceColumn, usesTemplateAwareStandaloneRoot } from "../src/preview/previewPolicy";

describe("preview policy", () => {
  test("inherits main language routing only through the dependency graph", () => {
    const main = [{ family: "Main Latin", script: "latin", scale: 1, language: "en" }];
    const local = [{ family: "Local Latin", script: "latin", scale: 1, language: "fr" }];
    expect(documentScriptsForPreviewContext("/project/chapter.typ", "/project/main.typ", true, [], main)).toBe(main);
    expect(documentScriptsForPreviewContext("/project/library.typ", "/project/main.typ", true, [], main)).toBe(main);
    expect(documentScriptsForPreviewContext("/project/unrelated.typ", "/project/main.typ", false, local, main)).toBe(local);
    expect(documentScriptsForPreviewContext("/project/unrelated.typ", "/project/main.typ", false, [], main)).toEqual([]);
  });

  test("guards the main compiler for included chapters and imported libraries", () => {
    const mainTarget = {
      rootPath: "C:\\project\\main.typ",
      mainPath: "C:\\project\\main.typ",
      imported: true,
      standalone: false,
      disabled: false,
    };
    expect(previewTargetStartsMainCompiler("C:\\project\\chapter.typ", mainTarget)).toBe(true);
    expect(previewTargetStartsMainCompiler("C:\\project\\template.typ", mainTarget)).toBe(true);
    expect(previewTargetStartsMainCompiler("C:\\project\\main.typ", mainTarget)).toBe(false);
    expect(previewTargetStartsMainCompiler("C:\\project\\unrelated.typ", {
      ...mainTarget,
      rootPath: "C:\\project\\unrelated.typ",
      imported: false,
      standalone: true,
      disabled: true,
    })).toBe(false);
  });
  test("keeps unrelated files out of preview compilation", () => {
    expect(participatesInPreviewCompilation("C:\\work\\main.typ", "c:/work/main.typ", false)).toBe(true);
    expect(participatesInPreviewCompilation("C:/work/chapter.typ", "C:/work/main.typ", true)).toBe(true);
    expect(participatesInPreviewCompilation("C:/work/notes.typ", "C:/work/main.typ", false)).toBe(false);
    expect(participatesInPreviewCompilation("C:/work/main.typ", null, false)).toBe(false);
  });

  test("blocks unrelated active files at every preview scheduling boundary", () => {
    expect(activeFileCanRenderPreview("C:/work/main.typ", "C:/work/main.typ", false, false)).toBe(true);
    expect(activeFileCanRenderPreview("C:/work/chapter.typ", "C:/work/main.typ", true, false)).toBe(true);
    expect(activeFileCanRenderPreview("C:/work/notes.typ", "C:/work/main.typ", false, false)).toBe(false);
    expect(activeFileCanRenderPreview("C:/work/main.typ", "C:/work/main.typ", false, true)).toBe(false);
    expect(activeFileCanRenderPreview("C:/work/data.csv", "C:/work/data.csv", false, false)).toBe(false);
  });

  test("applies preview ownership to mutation, scheduling, rendering, and preparation", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const methodSource = (name: string) => {
      const start = source.indexOf(`  private ${name}`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = source.indexOf("\n  private ", start + 10);
      return source.slice(start, end < 0 ? source.length : end);
    };
    for (const method of [
      "async renderPdfPreview",
      "schedulePdfPreview",
      "handleContentMutation",
      "async prepareRenderProjectIfNeeded"
    ]) {
      expect(methodSource(method)).toContain("activeFileCanRenderPreview(");
    }
  });
  test("keeps standalone preview disabled for v1.0", () => {
    expect(allowsStandalonePreview("// @standalone-preview\n= Chapter")).toBe(false);
    expect(allowsStandalonePreview("\uFEFF// @standalone-preview\n= Chapter")).toBe(false);
    expect(allowsStandalonePreview("= Chapter")).toBe(false);
    expect(allowsStandalonePreview("// @allow-preview\n= Legacy chapter")).toBe(false);
  });

  test("uses the selected refresh mode independently of preview roots", () => {
    expect(previewRefreshStyle("on-save")).toBe("on-save");
    expect(previewRefreshStyle("on-type")).toBe("on-type");
  });

  test("creates stable distinct task IDs for each refresh policy", () => {
    const live = previewSessionIdentity("C:\\docs\\main.typ", "on-type");
    const saved = previewSessionIdentity("C:\\docs\\main.typ", "on-save");
    expect(live).toEqual(previewSessionIdentity("C:\\docs\\main.typ", "on-type"));
    expect(live.taskId).not.toBe(saved.taskId);
  });

  test("pins a standalone preview to its compilation root", () => {
    expect(previewLspMainPath({
      rootPath: "/workspace/.chapter.preview.typ",
      mainPath: "/workspace/main.typ",
      standalone: true
    })).toBe("/workspace/.chapter.preview.typ");
    expect(previewLspMainPath({
      rootPath: "/workspace/main.typ",
      mainPath: "/workspace/main.typ",
      standalone: false
    })).toBe("/workspace/main.typ");
  });

  test("computes UTF-8 byte columns for render-cache offsets", () => {
    const line = "Latin ខ្មែរ text";
    const offset = line.indexOf(" text");
    expect(tinymistPreviewByteColumn(line, offset)).toBe(new TextEncoder().encode("Latin ខ្មែរ").length);
    expect(tinymistPreviewByteColumn("😀x", 2)).toBe(4);
  });

  test("creates nearby byte offsets only at Unicode boundaries", () => {
    expect(tinymistPreviewNearbyByteColumns("a😀ខb", 3, 5)).toEqual([5, 8, 9, 1, 0]);
  });

  test("uses Unicode code-point columns for Tinymist preview requests", () => {
    const line = `a\u{1F600}\u1781b`;
    expect(tinymistPreviewSourceColumn(line, 3)).toBe(2);
    expect(tinymistPreviewNearbySourceColumns(line, 3, 5)).toEqual([2, 3, 4, 1, 0]);
  });

  test("chooses one likely rendered position for forward sync", () => {
    expect(tinymistPreviewPreferredSourceColumn("Hello", 0)).toBe(1);
    expect(tinymistPreviewPreferredSourceColumn("Hello", 3)).toBe(3);
    expect(tinymistPreviewPreferredSourceColumn("= Heading", 0)).toBe(3);
    expect(tinymistPreviewPreferredSourceColumn("  Khmer", 1)).toBe(3);
    expect(tinymistPreviewPreferredSourceColumn("😀 text", 0)).toBe(1);
    expect(tinymistPreviewPreferredSourceColumn("   ", 1)).toBe(1);
  });

  test("keeps original source paths for template-aware standalone wrappers", () => {
    const active = "C:\\workspace\\chapters\\one.typ";
    expect(usesTemplateAwareStandaloneRoot(
      active,
      "C:/workspace/.one.typ.task.typsastra-preview.typ",
      true
    )).toBe(true);
    expect(usesTemplateAwareStandaloneRoot(active, active, true)).toBe(false);
    expect(usesTemplateAwareStandaloneRoot(active, "C:/workspace/main.typ", false)).toBe(false);
  });

  test("keys a research document by workspace and configured main file", () => {
    const chapter = researchDocumentIdentity("C:\\research", "C:\\research\\main.typ", "C:\\research\\chapters\\one.typ");
    const sibling = researchDocumentIdentity("C:\\research", "C:\\research\\main.typ", "C:\\research\\chapters\\two.typ");
    expect(chapter.cacheKey).toBe(sibling.cacheKey);
    expect(chapter.sourceKey).not.toBe(sibling.sourceKey);
    expect(previewSessionIdentity("C:\\research\\main.typ", "on-type", chapter))
      .toEqual(previewSessionIdentity("C:\\research\\main.typ", "on-type", sibling));
  });

  test("isolates identical main paths owned by different workspaces", () => {
    const first = researchDocumentIdentity("C:\\one", "C:\\one\\main.typ", "C:\\one\\main.typ");
    const second = researchDocumentIdentity("C:\\two", "C:\\two\\main.typ", "C:\\two\\main.typ");
    expect(previewSessionIdentity("main.typ", "on-type", first).key)
      .not.toBe(previewSessionIdentity("main.typ", "on-type", second).key);
  });

  test("enables Tinymist partial rendering for live previews", () => {
    const args = tinymistPreviewArguments("C:\\docs\\main.typ", "preview-1", "on-type");
    expect(args).toContain("--partial-rendering");
    expect(args[args.indexOf("--partial-rendering") + 1]).toBe("true");
  });

  test("disables expensive partial rendering under Linux WebKitGTK", () => {
    expect(supportsResponsivePartialRendering("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1")).toBe(false);
    expect(supportsResponsivePartialRendering("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(true);
    expect(tinymistPreviewArguments("/docs/main.typ", "preview-1", "on-type", false))
      .not.toContain("--partial-rendering");
  });

  test("uses one dedicated source-map task and cleans legacy registrations", () => {
    expect(sourceMapPreviewTaskId("preview-1")).toBe("preview-1-source-map");
    expect(sourceMapPreviewTaskId("preview-1-source-map")).toBe("preview-1-source-map");
    expect(staleSourceMapTaskIds("preview-1", "preview-old-source-map")).toEqual([
      "preview-old-source-map",
      "preview-1",
      "preview-1-source-map"
    ]);
  });
});

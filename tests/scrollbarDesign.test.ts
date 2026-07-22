import { describe, expect, test } from "bun:test";

describe("cross-platform scrollbar design", () => {
  test("styles application scrollbars while preserving the hidden tab strip", async () => {
    const css = await Bun.file(new URL("../src/style.css", import.meta.url)).text();
    expect(css).toContain("--ui-scrollbar-thumb");
    expect(css).toContain("--ui-scrollbar-track: transparent");
    expect(css).toContain("*::-webkit-scrollbar");
    expect(css).toContain("border-radius: 0");
    expect(css).toContain("@supports not selector(::-webkit-scrollbar)");
    expect(css).toContain("scrollbar-color: var(--ui-scrollbar-thumb) var(--ui-scrollbar-track)");
    expect(css).toContain(".editor-tab-bar::-webkit-scrollbar");
    expect(css).toContain("scrollbar-width: none");
  });

  test("applies matching custom geometry inside the isolated PDF iframe", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    expect(source).toMatch(/body::\-webkit-scrollbar\{width:\d+px;height:\d+px\}/);
    expect(source).not.toContain("*::-webkit-scrollbar");
    expect(source).toContain("@supports not selector(::-webkit-scrollbar)");
    expect(source).toContain("scrollbar-color:var(--scrollbar-thumb) var(--scrollbar-track)");
    expect(source).toContain("border-radius:0");
    expect(source).toContain('copy("--ui-accent-color", "--preview-ui-accent"');
    expect(source).toContain("var(--preview-ui-accent)");
  });

  test("does not build an unused PDF text layer", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    expect(source).not.toContain("renderTextLayer");
    expect(source).not.toContain('className = "textLayer"');
    expect(source).toContain("hydratePageDimensions");
  });

  test("uses immediate programmatic page jumps and reports the visible page", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    expect(source).toContain('behavior: "auto"');
    expect(source).not.toContain('behavior: "smooth"');
    expect(source).toContain("finishInstantPageJump");
    expect(source).toContain("reportPageStatus");
  });

  test("provides editable page navigation in the shared preview toolbar", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(html).toContain('id="preview-page-input"');
    expect(html).toContain('id="preview-page-count"');
    expect(html).toContain('role="spinbutton"');
  });

  test("preserves a compiled PDF behind non-Typst preview messages", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    const controller = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    expect(source).toContain("setMessageOverlay(html: string)");
    expect(source).toContain("this.mountedSessionKey !== sessionKey");
    expect(source).toContain("this.clearMessageHost();");
    expect(controller).toContain("this.previewFrame.setMessageOverlay(");
    expect(controller).toContain("previewPresentationReused = this.previewFrame.activateSession(tab.previewSessionKey)");
  });
});

import { describe, expect, test } from "bun:test";
import { pageDimensionsChanged, pagesToEvict, visiblePageIndexes } from "../src/preview/virtualization";

describe("PDF preview virtualization", () => {
  test("keeps the focused page and its nearest neighbors resident", () => {
    const rendered = Array.from({ length: 20 }, (_, index) => index + 1);
    const evicted = new Set(pagesToEvict(rendered, 10, 7));
    const retained = rendered.filter(page => !evicted.has(page));
    expect(retained).toEqual([7, 8, 9, 10, 11, 12, 13]);
  });

  test("does not evict a visible window already under budget", () => {
    expect(pagesToEvict([4, 5, 6], 5, 7)).toEqual([]);
  });

  test("avoids layout writes for unchanged estimated page geometry", () => {
    const dimensions = { width: 595.28, height: 841.89 };
    expect(pageDimensionsChanged(dimensions, { ...dimensions })).toBe(false);
    expect(pageDimensionsChanged(dimensions, { width: 841.89, height: 595.28 })).toBe(true);
  });

  test("returns every split-viewport page in visible-area order", () => {
    const tops = [0, 820, 1_640, 2_460];
    const indexes = visiblePageIndexes(
      tops.length,
      index => tops[index],
      () => 800,
      700,
      1_000
    );
    expect(indexes).toEqual([1, 0, 2]);
  });

  test("uses motion-aware priority rendering without a fixed scroll timeout", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    expect(source).toContain("PreviewMotionController");
    expect(source).toContain("PreviewRenderScheduler");
    expect(source).toContain("pumpPageRenderQueue");
    expect(source).toContain("deferPageRenderingDuringScroll");
    expect(source).toContain("deceleration-prerender");
    expect(source).not.toContain("scrollResumeTimer");
    expect(source).not.toContain("}, 120)");
    expect(source).not.toContain("if (entry.isIntersecting) void this.renderPage");
  });
});

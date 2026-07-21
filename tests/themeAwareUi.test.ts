import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const style = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const controller = readFileSync(new URL("../src/appController.ts", import.meta.url), "utf8");
const explorer = readFileSync(new URL("../src/components/explorer.ts", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("theme-aware application accents", () => {
  test("uses the active theme for the no-main-file placeholder", () => {
    expect(controller).toContain("preview-disabled-title preview-accent-title");
    expect(controller).not.toContain("color:#3db489");
    expect(style).toMatch(/\.preview-disabled-title\.preview-accent-title\s*\{[^}]*var\(--ui-accent-color\)/s);
  });

  test("uses shared accent variables for application controls", () => {
    expect(style).toContain("--ui-accent-foreground: var(--ui-bg)");
    expect(style).toContain("--ui-accent-hover: color-mix(");
    expect(html).toContain("background: var(--ui-accent-color)");
    expect(html).toContain("color: var(--ui-accent-foreground)");
    expect(explorer).toContain('input.style.border = "1px solid var(--ui-accent-color)"');
  });

  test("does not use the cursor color as a generic UI accent", () => {
    expect(style).not.toMatch(/\.log-console-tab\.active\s*\{[^}]*editor-cursor-color/s);
    expect(style).toMatch(/\.workspace-loading-spinner\s*\{[^}]*var\(--ui-accent-color\)/s);
  });
});

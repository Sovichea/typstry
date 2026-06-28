import { describe, expect, test } from "bun:test";
import { cloneDefaultAppSettings, defaultAppSettings, normalizeAppSettings } from "../src/settings";

describe("application settings", () => {
  test("fills missing values from defaults", () => {
    const settings = normalizeAppSettings({ appearance: { theme: "nord" } });

    expect(settings.appearance.theme).toBe("nord");
    expect(settings.editor.codeFont).toBe("fira-mono");
    expect(settings.editor.unicodeFont).toBe("auto");
    expect(settings.editor.wordWrap).toBe(defaultAppSettings.editor.wordWrap);
    expect(settings.preview.syncDebounceMs).toBe(defaultAppSettings.preview.syncDebounceMs);
  });

  test("rejects unsupported enums and clamps numeric values", () => {
    const settings = normalizeAppSettings({
      appearance: { theme: "unknown", editorFontSize: 80, editorLineHeight: 0.5 },
      editor: { tabSize: 3, codeFont: "MiSans Latin", unicodeFont: "unknown-font" },
      preview: { syncDebounceMs: 1, highlightDurationMs: 50000 }
    });

    expect(settings.appearance.theme).toBe("default");
    expect(settings.appearance.editorFontSize).toBe(32);
    expect(settings.appearance.editorLineHeight).toBe(1.2);
    expect(settings.editor.tabSize).toBe(2);
    expect(settings.editor.codeFont).toBe("fira-mono");
    expect(settings.editor.unicodeFont).toBe("auto");
    expect(settings.preview.syncDebounceMs).toBe(50);
    expect(settings.preview.highlightDurationMs).toBe(10000);
  });

  test("returns independent default objects", () => {
    const first = cloneDefaultAppSettings();
    const second = cloneDefaultAppSettings();
    first.editor.wordWrap = false;

    expect(second.editor.wordWrap).toBe(true);
  });
});

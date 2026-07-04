import { describe, expect, test } from "bun:test";
import { cloneDefaultAppSettings, defaultAppSettings, normalizeAppSettings } from "../src/settings";

describe("application settings", () => {
  test("fills missing values from defaults", () => {
    const settings = normalizeAppSettings({ appearance: { theme: "nord" } });

    expect(settings.appearance.theme).toBe("nord");
    expect(settings.editor.codeFont).toBe("Fira Mono");
    expect(settings.editor.unicodeFont).toBe("auto");
    expect(settings.editor.wordWrap).toBe(defaultAppSettings.editor.wordWrap);
    expect(settings.editor.spellcheck).toBe(true);
    expect(settings.editor.wordCompletion).toBe(true);
    expect(settings.editor.showZws).toBe(true);
    expect(settings.editor.userDictionary).toEqual([]);
    expect(settings.preview.syncDebounceMs).toBe(defaultAppSettings.preview.syncDebounceMs);
    expect(settings.preview.khmerRenderPreparation).toBe(false);
    expect(settings.toolchain.tinymistVersion).toBeNull();
  });

  test("rejects unsupported enums and clamps numeric values", () => {
    const settings = normalizeAppSettings({
      appearance: { theme: "unknown", editorFontSize: 80, editorLineHeight: 0.5 },
      editor: { tabSize: 3, codeFont: "MiSans Latin", unicodeFont: "unknown-font" },
      preview: { syncDebounceMs: 1, highlightDurationMs: 50000 },
      toolchain: { tinymistVersion: "0.15.1-rc.1" }
    });

    expect(settings.appearance.theme).toBe("default");
    expect(settings.appearance.editorFontSize).toBe(32);
    expect(settings.appearance.editorLineHeight).toBe(1.2);
    expect(settings.editor.tabSize).toBe(2);
    expect(settings.editor.codeFont).toBe("Fira Mono");
    expect(settings.editor.unicodeFont).toBe("unknown-font");
    expect(settings.preview.syncDebounceMs).toBe(50);
    expect(settings.preview.highlightDurationMs).toBe(10000);
    expect(settings.toolchain.tinymistVersion).toBeNull();
  });

  test("keeps a selected stable Tinymist version", () => {
    expect(normalizeAppSettings({ toolchain: { tinymistVersion: "0.15.2" } }).toolchain.tinymistVersion).toBe("0.15.2");
  });

  test("migrates the former Typst version selection", () => {
    expect(normalizeAppSettings({ toolchain: { typstVersion: "0.14.2" } }).toolchain.tinymistVersion).toBe("0.14.2");
  });

  test("returns independent default objects", () => {
    const first = cloneDefaultAppSettings();
    const second = cloneDefaultAppSettings();
    first.editor.wordWrap = false;

    expect(second.editor.wordWrap).toBe(true);
  });

  test("normalizes and deduplicates personal dictionary words", () => {
    const settings = normalizeAppSettings({
      editor: { wordCompletion: false, userDictionary: [" សាលា ", "សាលា", "", 42] }
    });
    expect(settings.editor.wordCompletion).toBe(false);
    expect(settings.editor.userDictionary).toEqual(["សាលា"]);
  });
});
